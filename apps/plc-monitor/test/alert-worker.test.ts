import {generateKeyPairSync} from "node:crypto";
import {expect,it,vi} from "vitest";
import {MonitorSigner} from "../src/signing.js";
import worker,{AlertDeduplicator,type Env} from "../deploy/cloudflare-alert-worker/worker.js";
import {encodeBase64Url} from "@racrproto/codec";
import {cidForCbor} from "@atproto/common";
import type {EmailBinding} from "../deploy/cloudflare-alert-worker/signup-email.js";
import {SIGNUP_ALERT_PATH,SIGNUP_BINDING_PATH,type MonitorEmailBindingQuery} from "../src/email-binding.js";
import {P256Keypair} from "@atproto/crypto";
import {didForCreateOp,signOperation} from "@did-plc/lib";
import {genesisIdentity} from "../deploy/cloudflare-alert-worker/signup-email.js";
import {hash} from "../src/http.js";

const providerOrigin="https://svr.provider.example",webOrigin="https://provider.example";
const newToken=()=>encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
/** A real signed genesis whose Hail service is at the given provider. */
async function genesis(origin=providerOrigin){
  const key=await P256Keypair.create();
  const operation=await signOperation({type:"plc_operation",prev:null,rotationKeys:[key.did()],
    verificationMethods:{"hail-identity":key.did(),"hail-messaging":key.did()},alsoKnownAs:[],
    services:{hail:{type:"HailMessaging",endpoint:`${origin}/hail`}}},key);
  return {operation,did:await didForCreateOp(operation),operationCid:(await cidForCbor(operation)).toString()};
}
/** Monitor-signed provider provisioning, as the shared monitor sends it. */
async function provision(signer:MonitorSigner,env:{ALERT_DEDUPLICATOR:unknown},record:{providerId:string;providerOrigin:string;webOrigin:string|null;token:string;enabled?:boolean;issuedAt?:number}){
  const bytes=new TextEncoder().encode(JSON.stringify({type:"hail.plc-monitor-receiver-provider",version:1,providerId:record.providerId,
    providerOrigin:record.providerOrigin,webOrigin:record.webOrigin,tokenHash:await hash(record.token),enabled:record.enabled??true,
    issuedAt:record.issuedAt??Math.floor(Date.now()/1000)}));
  return worker.fetch(new Request("https://alerts.plcmonitor.us/hail/providers",{method:"POST",headers:{"Content-Type":"application/json",
    "X-Hail-Monitor-Key":signer.publicDidKey,"X-Hail-Monitor-Signature":encodeBase64Url(signer.signReceiverProvider(bytes))},body:bytes}),env as never);
}
type EmailMessage=Parameters<EmailBinding["send"]>[0];

function deduplicator(env:Record<string,unknown>){
  let alarm:number|null=null,queue:Promise<unknown>=Promise.resolve();
  const values=new Map<string,unknown>(),storage={get:async(key:string)=>values.get(key),put:async(key:string,value:unknown)=>{values.set(key,value)},
    delete:async(key:string)=>values.delete(key),list:async({prefix}:{prefix:string})=>new Map([...values].filter(([key])=>key.startsWith(prefix))),
    getAlarm:async()=>alarm,setAlarm:async(time:number)=>{alarm=time;},
    transaction:<T>(callback:(value:unknown)=>Promise<T>):Promise<T>=>{
      const result=queue.then(()=>callback(storage));queue=result.catch(()=>{});return result;
    }};
  const object=new AlertDeduplicator({storage} as never,env as never);
  return {idFromName:(name:string)=>name,get:()=>({fetch:(request:Request)=>object.fetch(request)}),values,object};
}

it("emails only a valid pinned signed monitor alert",async()=>{
  const signer=new MonitorSigner(generateKeyPairSync("ed25519").privateKey),
    send=vi.fn(async(_message:EmailMessage)=>({messageId:"test"}));
  const env:any={EMAIL:{send},ALERT_RECIPIENT:"the@j4w8n.com",ALERT_SENDER:"alerts@plcmonitor.us",MONITOR_PUBLIC_KEY:signer.publicDidKey,
    HEARTBEAT_TOKEN:"token",BACKUP_TOKEN:"backup",PROVIDER_HEALTH_URL:"https://haili.app/health/ready",HAIL_PRODUCTION_MONITOR:{get:vi.fn(),put:vi.fn()}};
  env.ALERT_DEDUPLICATOR=deduplicator(env);
  const payload=JSON.stringify({type:"hail.plc-monitor-alert",version:1,id:"00000000-0000-0000-0000-000000000000",
    did:`did:plc:${"a".repeat(24)}`,category:"unexpected-operation",detail:{operationCid:"bafyrei"},occurred_at:new Date().toISOString()});
  const bytes=new TextEncoder().encode(payload),request=(signature:Uint8Array)=>new Request("https://alerts.plcmonitor.us/hail",{
    method:"POST",headers:{"Content-Type":"application/json","Content-Length":String(bytes.length),
      "X-Hail-Monitor-Key":signer.publicDidKey,"X-Hail-Monitor-Signature":encodeBase64Url(signature)},body:bytes});
  expect((await worker.fetch(request(signer.signAlert(bytes)),env)).status).toBe(204);
  expect((await worker.fetch(request(signer.signAlert(bytes)),env)).status).toBe(204);
  expect(send).toHaveBeenCalledWith(expect.objectContaining({to:"the@j4w8n.com",from:{email:"alerts@plcmonitor.us",name:"Hail"}}));
  expect(send.mock.calls[0]![0].text).not.toContain("Monitor key:");
  const bad=signer.signAlert(bytes);bad[0]=bad[0]!^1;
  expect((await worker.fetch(request(bad),env)).status).toBe(401);
  const staleBytes=new TextEncoder().encode(JSON.stringify({...JSON.parse(payload),id:"00000000-0000-0000-0000-000000000001",
    occurred_at:new Date(Date.now()-8*86400_000).toISOString()}));
  expect((await worker.fetch(new Request("https://alerts.plcmonitor.us/hail",{method:"POST",headers:{"Content-Type":"application/json",
    "X-Hail-Monitor-Key":signer.publicDidKey,"X-Hail-Monitor-Signature":encodeBase64Url(signer.signAlert(staleBytes))},body:staleBytes}),env)).status).toBe(400);
  expect(send).toHaveBeenCalledOnce();
});

it("accepts authenticated heartbeats and alerts only on health transitions",async()=>{
  const values=new Map<string,string>(),send=vi.fn(async(_message:EmailMessage)=>({messageId:"test"})),put=vi.fn(async(key:string,value:string)=>{values.set(key,value)}),
    env:any={EMAIL:{send},ALERT_RECIPIENT:"the@j4w8n.com",ALERT_SENDER:"alerts@plcmonitor.us",MONITOR_PUBLIC_KEY:"unused",
      HEARTBEAT_TOKEN:"secret",BACKUP_TOKEN:"backup",PROVIDER_HEALTH_URL:"https://haili.app/health/ready",HAIL_PRODUCTION_MONITOR:{get:async(key:string)=>values.get(key)??null,put}};
  env.ALERT_DEDUPLICATOR=deduplicator(env);
  expect((await worker.fetch(new Request("https://alerts.plcmonitor.us/heartbeat",{method:"POST",headers:{Authorization:"Bearer wrong"}}),env)).status).toBe(401);
  expect((await worker.fetch(new Request("https://alerts.plcmonitor.us/heartbeat",{method:"POST",headers:{Authorization:"Bearer secret"}}),env)).status).toBe(204);
  expect((await worker.fetch(new Request("https://alerts.plcmonitor.us/backup-heartbeat",{method:"POST",headers:{Authorization:"Bearer backup"}}),env)).status).toBe(204);
  const originalFetch=globalThis.fetch;globalThis.fetch=vi.fn(async()=>new Response(null,{status:200})) as unknown as typeof fetch;
  try{await worker.scheduled({},env);await worker.scheduled({},env);}finally{globalThis.fetch=originalFetch;}
  expect(send).not.toHaveBeenCalled();expect(put).toHaveBeenCalledTimes(5);
  values.set("monitor-heartbeat",String(Date.now()-7*60_000));
  values.set("backup-heartbeat",String(Date.now()-27*60*60_000));
  const originalFetch2=globalThis.fetch;globalThis.fetch=vi.fn(async()=>new Response(null,{status:503})) as unknown as typeof fetch;
  try{await worker.scheduled({},env);await worker.scheduled({},env);}finally{globalThis.fetch=originalFetch2;}
  expect(send).toHaveBeenCalledTimes(3);
  expect(send.mock.calls.map(call=>call[0].subject)).toEqual(["[Hail ops] haili provider down","[Hail ops] PLC monitor down","[Hail ops] provider backup down"]);
  await worker.fetch(new Request("https://alerts.plcmonitor.us/heartbeat",{method:"POST",headers:{Authorization:"Bearer secret"}}),env);
  await worker.fetch(new Request("https://alerts.plcmonitor.us/backup-heartbeat",{method:"POST",headers:{Authorization:"Bearer backup"}}),env);
  const originalFetch3=globalThis.fetch;globalThis.fetch=vi.fn(async()=>new Response(null,{status:200})) as unknown as typeof fetch;
  try{await worker.scheduled({},env);await worker.scheduled({},env);}finally{globalThis.fetch=originalFetch3;}
  expect(send.mock.calls.slice(3).map(call=>call[0].subject)).toEqual(["[Hail ops] haili provider ok","[Hail ops] PLC monitor ok","[Hail ops] provider backup ok"]);
  expect(put).toHaveBeenCalledTimes(13);
});

async function signupFixture(){
  const signer=new MonitorSigner(generateKeyPairSync("ed25519").privateKey);
  const send=vi.fn(async(_message:EmailMessage)=>({messageId:"test"}));
  const env:Env={EMAIL:{send},ALERT_RECIPIENT:"operator@example.com",ALERT_SENDER:"security@notify.racrproto.com",
    SIGNUP_SENDER:"welcome@notify.racrproto.com",MONITOR_PUBLIC_KEY:signer.publicDidKey,ALERT_DEDUPLICATOR:null as never};
  const coordinator=deduplicator(env as unknown as Record<string,unknown>);env.ALERT_DEDUPLICATOR=coordinator;
  const provider={providerId:crypto.randomUUID(),providerOrigin,webOrigin,token:newToken()};
  expect((await provision(signer,env,provider)).status).toBe(204);
  const identity={signupId:crypto.randomUUID(),signupHash:encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)))};
  const signup=(id:string=identity.signupId)=>`signup:${provider.providerId}:${id}`;
  const post=(path:string,input:unknown,token=provider.token)=>worker.fetch(new Request(`https://alerts.plcmonitor.us${path}`,{
    method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`},body:JSON.stringify(input)}),env);
  const challenge=()=>send.mock.calls.at(-1)![0].text.match(/code is: (\d{8})/)![1]!;
  const alert=(did:string,id:string=crypto.randomUUID())=>{
    const bytes=new TextEncoder().encode(JSON.stringify({type:"hail.plc-monitor-alert",version:1,id,did,category:"unexpected-operation",
      detail:{operationCid:"bafyrei"},occurred_at:new Date(Date.now()).toISOString()}));
    return new Request("https://alerts.plcmonitor.us/hail",{method:"POST",headers:{"Content-Type":"application/json",
      "X-Hail-Monitor-Key":signer.publicDidKey,"X-Hail-Monitor-Signature":encodeBase64Url(signer.signAlert(bytes))},body:bytes});
  };
  return {env,send,coordinator,identity,post,challenge,alert,signer,provider,signup};
}

it("separates the signup URL from punctuation and displays Hail as the sender",async()=>{
  const f=await signupFixture();
  expect((await f.post("/signup-email",{...f.identity,email:"alice@example.com"})).status).toBe(200);
  const message=f.send.mock.calls[0]![0];
  expect(message.text.match(/https:\/\/\S+/g)).toEqual(["https://provider.example/"]);
  expect(message.text.split("\n")).toContain("https://provider.example/");
  expect(message.from).toEqual({email:"welcome@notify.racrproto.com",name:"Hail"});
});

it("authenticates signup verification, stores only code hashes and binds one verified destination to one exact signup identity",async()=>{
  const f=await signupFixture(),input={...f.identity,email:"alice@example.com"};
  expect((await f.post("/signup-email",input,"wrong")).status).toBe(401);
  expect((await f.post("/signup-email",input,newToken())).status).toBe(401);
  const token=f.provider.token;
  for(const invalid of [null,{...input,email:"alice@example.com\r\nBcc: victim@example.com"},{...input,html:"arbitrary email"},
    {...input,signupHash:"not-a-hash"},{...input,email:"a..b@example.com"}])
    expect((await f.post("/signup-email",invalid)).status).toBe(400);
  const duplicate=new Request("https://alerts.plcmonitor.us/signup-email",{method:"POST",headers:{"Content-Type":"application/json",
    Authorization:`Bearer ${token}`},body:`{"signupId":"${input.signupId}","signupHash":"${input.signupHash}","email":"alice@example.com","email":"bob@example.com"}`});
  expect((await worker.fetch(duplicate,f.env)).status).toBe(400);
  const start=await f.post("/signup-email",input),result=await start.json() as Record<string,unknown>;
  expect(start.status).toBe(200);expect(result.verified).toBe(false);
  const code=f.challenge();expect(JSON.stringify(result)).not.toContain(code);
  expect(JSON.stringify([...f.coordinator.values])).not.toContain(code);
  expect(f.send).toHaveBeenCalledWith(expect.objectContaining({to:input.email,from:{email:"welcome@notify.racrproto.com",name:"Hail"}}));
  expect((await f.post("/signup-email",input)).status).toBe(200);expect(f.send).toHaveBeenCalledOnce();
  expect((await f.post("/signup-email",{...input,email:"bob@example.com"})).status).toBe(409);
  const {did,operationCid,operation}=await genesis();
  const binding={...f.identity,did,operationCid,operation,hailAddress:"alice@hail.example"};
  expect((await f.post("/signup-email/bind",binding)).status).toBe(409);
  expect((await f.post("/signup-email/verify",{...f.identity,code:code==="00000000"?"00000001":"00000000"})).status).toBe(409);
  expect((await f.post("/signup-email/verify",{...f.identity,code})).status).toBe(200);
  expect((f.coordinator.values.get(f.signup()) as {codeHash:unknown}).codeHash).toBeNull();
  expect((await f.post("/signup-email/verify",{...f.identity,code})).status).toBe(200);
  expect((await f.post("/signup-email/bind",binding)).status).toBe(200);
  expect((await f.post("/signup-email/bind",{...binding,hailAddress:"mallory@hail.example"})).status).toBe(409);
  expect((await f.post("/signup-email/bind",{...binding,hailAddress:"alice\r\nBcc: victim"})).status).toBe(400);
  // An old sender's retry cannot erase the retained address.
  expect((await f.post("/signup-email/bind",{...f.identity,did,operationCid,operation})).status).toBe(200);

  expect((await f.post("/signup-email/bind",binding)).status).toBe(200);
  // The DID and CID must be the exact genesis, and the genesis must name this provider.
  expect((await f.post("/signup-email/bind",{...binding,did:`did:plc:${"b".repeat(24)}`})).status).toBe(400);
  expect((await f.post("/signup-email/bind",{...binding,operationCid:(await cidForCbor({genesis:"different"})).toString()})).status).toBe(400);
  const {operation:omitted,...withoutGenesis}=binding;expect(omitted).toBeTruthy();
  expect((await f.post("/signup-email/bind",withoutGenesis)).status).toBe(400);
  const other2=await genesis();
  expect((await f.post("/signup-email/bind",{...binding,...other2})).status).toBe(409);
  const other={signupId:crypto.randomUUID(),signupHash:encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)))};
  await f.post("/signup-email",{...other,email:"bob@example.com"});
  await f.post("/signup-email/verify",{...other,code:f.challenge()});
  expect((await f.post("/signup-email/bind",{...other,did,operationCid,operation})).status).toBe(409);
  const request=f.alert(did);
  expect((await worker.fetch(request.clone(),f.env)).status).toBe(204);
  expect(f.send.mock.calls.at(-1)![0]).toMatchObject({to:"alice@example.com",from:{email:"security@notify.racrproto.com",name:"Hail"}});
  expect(f.send.mock.calls.at(-1)![0].subject).toContain("alice@hail.example");
  expect(f.send.mock.calls.at(-1)![0].text).toContain("Hail address: alice@hail.example");
  const count=f.send.mock.calls.length;
  expect((await worker.fetch(request.clone(),f.env)).status).toBe(204);expect(f.send).toHaveBeenCalledTimes(count);
  const changed=f.alert(`did:plc:${"c".repeat(24)}`,(await request.clone().json() as {id:string}).id);
  expect((await worker.fetch(changed,f.env)).status).toBe(409);
  expect((await worker.fetch(f.alert(`did:plc:${"d".repeat(24)}`),f.env)).status).toBe(204);
  expect(f.send.mock.calls.at(-1)![0].to).toBe("operator@example.com");
});

it("bounds guesses, explicit resends and proof lifetime without treating email as account recovery",async()=>{
  let now=Date.now();const clock=vi.spyOn(Date,"now").mockImplementation(()=>now);
  try{
    const f=await signupFixture(),input={...f.identity,email:"alice@example.com"};
    await f.post("/signup-email",input);const original=f.challenge(),wrong=original==="00000000"?"00000001":"00000000";
    for(let i=0;i<5;i++)expect((await f.post("/signup-email/verify",{...f.identity,code:wrong})).status).toBe(409);
    expect((await f.post("/signup-email/verify",{...f.identity,code:original})).status).toBe(429);
    expect((await f.post("/signup-email",{...input,resend:true})).status).toBe(429);
    now+=61_000;
    expect((await f.post("/signup-email",{...input,resend:true})).status).toBe(200);
    const latest=f.challenge();
    expect((await f.post("/signup-email/verify",{...f.identity,code:latest})).status).toBe(200);
    now+=25*3_600_000;
    expect((await f.post("/signup-email/bind",{...f.identity,...await genesis()})).status).toBe(409);
    await f.coordinator.object.alarm();
    expect(f.coordinator.values.has(f.signup())).toBe(false);
    const pending=await signupFixture();await pending.post("/signup-email",{...pending.identity,email:"pending@example.com"});
    const code=pending.challenge();now+=11*60_000;
    expect((await pending.post("/signup-email/verify",{...pending.identity,code})).status).toBe(409);
  }finally{clock.mockRestore();}
});

it("persists mailbox and global sending limits across new signup IDs",async()=>{
  const f=await signupFixture();
  for(let i=0;i<6;i++){
    const result=await f.post("/signup-email",{...f.identity,signupId:crypto.randomUUID(),email:"alice@example.com"});
    expect(result.status).toBe(i<5?200:429);
  }
  expect(f.send).toHaveBeenCalledTimes(5);
  f.coordinator.values.set(`email-rate:provider:${f.provider.providerId}`,{count:100,expiresAt:Date.now()+3_600_000});
  expect((await f.post("/signup-email",{...f.identity,signupId:crypto.randomUUID(),email:"another@example.com"})).status).toBe(429);
  f.coordinator.values.delete(`email-rate:provider:${f.provider.providerId}`);
  f.coordinator.values.set("email-rate:global",{count:1000,expiresAt:Date.now()+3_600_000});
  expect((await f.post("/signup-email",{...f.identity,email:"another@example.com"})).status).toBe(429);
  expect(f.send).toHaveBeenCalledTimes(5);
});

it("does not acknowledge an in-flight alert and retries failures without exposing vendor errors",async()=>{
  const f=await signupFixture();
  let release!:(value:{messageId:string})=>void,entered!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;});
  f.send.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;entered();}));
  const request=f.alert(`did:plc:${"a".repeat(24)}`),first=worker.fetch(request.clone(),f.env);
  await started;
  expect((await worker.fetch(request.clone(),f.env)).status).toBe(503);
  release({messageId:"test"});expect((await first).status).toBe(204);
  expect((await worker.fetch(request.clone(),f.env)).status).toBe(204);expect(f.send).toHaveBeenCalledOnce();
  f.send.mockRejectedValueOnce(new Error("vendor error with private recipient and content"));
  const failed=f.alert(`did:plc:${"b".repeat(24)}`);
  expect((await worker.fetch(failed.clone(),f.env)).status).toBe(503);
  expect((await worker.fetch(failed.clone(),f.env)).status).toBe(204);
  f.send.mockRejectedValueOnce(new Error("vendor secret"));
  const response=await f.post("/signup-email",{...f.identity,email:"failed@example.com"});
  expect(response.status).toBe(503);expect(await response.text()).not.toContain("vendor secret");
});

it("requires a domain-separated monitor signature to confirm an exact verified email binding",async()=>{
  const f=await signupFixture(),{did,operationCid,operation}=await genesis();
  const query:MonitorEmailBindingQuery={type:"hail.plc-monitor-email-binding",version:1,...f.identity,did,operationCid,issuedAt:Math.floor(Date.now()/1000)};
  const check=(value:MonitorEmailBindingQuery=query,wrongDomain=false)=>{
    const bytes=new TextEncoder().encode(JSON.stringify(value));
    return worker.fetch(new Request(`https://alerts.plcmonitor.us${SIGNUP_BINDING_PATH}`,{method:"POST",headers:{"Content-Type":"application/json",
      "X-Hail-Monitor-Key":f.signer.publicDidKey,"X-Hail-Monitor-Signature":encodeBase64Url(wrongDomain?f.signer.signAlert(bytes):f.signer.signEmailBindingRequest(bytes))},body:bytes}),f.env);
  };
  expect((await check()).status).toBe(409);
  await f.post("/signup-email",{...f.identity,email:"alice@example.com"});
  expect((await check()).status).toBe(409);
  await f.post("/signup-email/verify",{...f.identity,code:f.challenge()});
  expect((await check()).status).toBe(409);
  await f.post("/signup-email/bind",{...f.identity,did,operationCid,operation});
  const response=await check();expect(response.status).toBe(200);
  expect(await response.json()).toEqual({bound:true,did,operationCid});
  expect((await check(query,true)).status).toBe(401);
  expect((await check({...query,issuedAt:query.issuedAt-301})).status).toBe(400);
  expect((await check({...query,signupId:crypto.randomUUID()})).status).toBe(409);
  expect((await check({...query,signupHash:encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)))})).status).toBe(409);
  expect((await check({...query,operationCid:(await cidForCbor({other:true})).toString()})).status).toBe(409);
  expect(f.send).toHaveBeenCalledOnce(); // Binding reads never send email or authorize login.
});

it("never substitutes operator fallback or its deduplication receipt for a consumer enrollment alert",async()=>{
  const f=await signupFixture(),{did,operationCid,operation}=await genesis();
  const original=f.alert(did),consumer=()=>new Request(`https://alerts.plcmonitor.us${SIGNUP_ALERT_PATH}`,original.clone());
  expect((await worker.fetch(original.clone(),f.env)).status).toBe(204);
  expect(f.send.mock.calls.at(-1)![0].to).toBe("operator@example.com");
  expect((await worker.fetch(consumer(),f.env)).status).toBe(409);expect(f.send).toHaveBeenCalledOnce();
  await f.post("/signup-email",{...f.identity,email:"alice@example.com"});
  await f.post("/signup-email/verify",{...f.identity,code:f.challenge()});
  await f.post("/signup-email/bind",{...f.identity,did,operationCid,operation});
  expect((await worker.fetch(consumer(),f.env)).status).toBe(204);
  expect(f.send.mock.calls.at(-1)![0].to).toBe("alice@example.com");expect(f.send).toHaveBeenCalledTimes(3);
  expect((await worker.fetch(consumer(),f.env)).status).toBe(204);expect(f.send).toHaveBeenCalledTimes(3);
  const enrollment={...(await original.clone().json() as Record<string,unknown>),id:crypto.randomUUID(),category:"onboarding-enrollment",detail:{operationCid}};
  const send=(cid:string)=>{
    const bytes=new TextEncoder().encode(JSON.stringify({...enrollment,detail:{operationCid:cid}}));
    return worker.fetch(new Request(`https://alerts.plcmonitor.us${SIGNUP_ALERT_PATH}`,{method:"POST",headers:{"Content-Type":"application/json",
      "X-Hail-Monitor-Key":f.signer.publicDidKey,"X-Hail-Monitor-Signature":encodeBase64Url(f.signer.signAlert(bytes))},body:bytes}),f.env);
  };
  expect((await send((await cidForCbor({wrong:true})).toString())).status).toBe(409);
  expect((await send(operationCid)).status).toBe(204);
});

it("sends provider invitations only through authenticated requests for the provider's own origin and deduplicates retries",async()=>{
  const f=await signupFixture();
  const input={id:crypto.randomUUID(),email:"invitee@example.com",url:`${webOrigin}/signup#invitation=payload.signature`,expiresAt:Math.floor(Date.now()/1000)+604800};
  const request=(body:unknown=input,token=f.provider.token)=>f.post("/signup-email/invite",body,token);
  expect((await request(input,"wrong")).status).toBe(401);
  expect((await request({...input,url:"https://evil.example/signup#invitation=payload.signature"})).status).toBe(400);
  expect((await request({...input,url:`${providerOrigin}/signup#invitation=payload.signature`})).status).toBe(400); // not the web origin
  expect((await request()).status).toBe(204);expect((await request()).status).toBe(204);expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.send.mock.calls[0]![0]).toMatchObject({to:input.email,subject:"You're invited to Hail"});
  expect(f.send.mock.calls[0]![0].text).toContain(input.url);
  expect(f.send.mock.calls[0]![0]).toHaveProperty("html",expect.stringContaining(`<a href="${input.url}">Join Now</a>`));
  expect((await request({...input,email:"other@example.com"})).status).toBe(409);
  f.send.mockRejectedValueOnce(new Error("ambiguous email failure"));
  const second={...input,id:crypto.randomUUID()};
  expect((await request(second)).status).toBe(503);expect((await request(second)).status).toBe(503);
  expect(f.send).toHaveBeenCalledTimes(2);
});

it("removes managed alert recipients idempotently, only for their provider, and discards delayed signed alerts", async () => {
  const f=await signupFixture(),{did,operationCid}=await genesis(),signupId=crypto.randomUUID();
  f.coordinator.values.set(`recipient:${did}`,{did,operationCid,signupId,email:"owner@example.com",providerId:f.provider.providerId});
  f.coordinator.values.set(f.signup(signupId),{email:"owner@example.com"});
  const remove=(body:unknown,token=f.provider.token)=>f.post("/signup-email/remove-monitoring",body,token);
  expect((await remove({did,operationCid},"wrong")).status).toBe(401);
  expect((await remove({did,operationCid,extra:true})).status).toBe(400);
  expect((await remove({did,operationCid:(await cidForCbor({other:true})).toString()})).status).toBe(409);
  const other={providerId:crypto.randomUUID(),providerOrigin:"https://svr.other.example",webOrigin:null,token:newToken()};
  expect((await provision(f.signer,f.env,other)).status).toBe(204);
  expect((await remove({did,operationCid},other.token)).status).toBe(409); // another provider cannot stop it
  expect(f.coordinator.values.has(`recipient:${did}`)).toBe(true);
  for(let i=0;i<2;i++)expect((await remove({did,operationCid})).status).toBe(204);
  expect(f.coordinator.values.has(`recipient:${did}`)).toBe(false);
  expect(f.coordinator.values.has(f.signup(signupId))).toBe(false);
  const signupHash=encodeBase64Url(new Uint8Array(32));
  f.coordinator.values.set(f.signup(signupId),{email:"owner@example.com",signupHash,state:"verified",verifiedAt:Date.now(),expiresAt:Date.now()+60_000});
  expect((await f.post("/signup-email/bind",{signupId,signupHash,...await genesis(),did,operationCid})).status).toBe(400);
  expect(f.coordinator.values.has(`recipient:${did}`)).toBe(false);

  const bytes=new TextEncoder().encode(JSON.stringify({type:"hail.plc-monitor-alert",version:1,id:crypto.randomUUID(),did,
    category:"unexpected-operation",detail:{},occurred_at:new Date().toISOString()}));
  expect((await worker.fetch(new Request("https://alerts.example.com/hail/signup",{method:"POST",headers:{
    "Content-Type":"application/json","X-Hail-Monitor-Key":f.signer.publicDidKey,
    "X-Hail-Monitor-Signature":encodeBase64Url(f.signer.signAlert(bytes)),
  },body:bytes}),f.env)).status).toBe(204);
  expect(f.send).not.toHaveBeenCalled();
});

it("requires monitor signatures for transferred recipient cleanup and never revives stopped bindings",async()=>{
  const f=await signupFixture(),did=`did:plc:${"a".repeat(24)}`,operationCid=(await cidForCbor({test:"lifecycle"})).toString();
  f.coordinator.values.set(`recipient:${did}`,{did,operationCid,email:"owner@example.com",signupId:"signup",signupHash:"hash",verifiedAt:Date.now(),
    providerId:f.provider.providerId});
  f.coordinator.values.set(f.signup("signup"),{email:"owner@example.com"});
  const lifecycle=async(action:"claim"|"stop",sign=f.signer.signReceiverLifecycle.bind(f.signer),issuedAt=Math.floor(Date.now()/1000))=>{
    const bytes=new TextEncoder().encode(JSON.stringify({type:"hail.plc-monitor-receiver-lifecycle",version:1,did,operationCid,action,issuedAt}));
    return worker.fetch(new Request("https://alerts.example/hail/signup/lifecycle",{method:"POST",headers:{"Content-Type":"application/json",
      "X-Hail-Monitor-Key":f.signer.publicDidKey,"X-Hail-Monitor-Signature":encodeBase64Url(sign(bytes))},body:bytes}),f.env);
  };
  expect((await lifecycle("claim",f.signer.signAlert.bind(f.signer))).status).toBe(401);
  expect((await lifecycle("claim",undefined,0)).status).toBe(400);
  expect((await lifecycle("claim")).status).toBe(204);
  expect((await lifecycle("claim")).status).toBe(204);
  expect((await f.post("/signup-email/remove-monitoring",{did,operationCid})).status).toBe(409);
  expect(f.coordinator.values.has(`recipient:${did}`)).toBe(true);
  expect((await lifecycle("stop")).status).toBe(204);
  expect((await lifecycle("stop")).status).toBe(204);
  expect((await lifecycle("claim")).status).toBe(409);
  expect(f.coordinator.values.has(`recipient:${did}`)).toBe(false);
  expect(f.coordinator.values.has(f.signup("signup"))).toBe(false);
});

it("computes the same DID and CID as the PLC library for a signed genesis",async()=>{
  for(let i=0;i<3;i++){
    const fixture=await genesis();
    expect(await genesisIdentity(JSON.parse(JSON.stringify(fixture.operation))))
      .toEqual({did:fixture.did,operationCid:fixture.operationCid,endpoint:`${providerOrigin}/hail`});
  }
  for(const invalid of [null,[],{type:"plc_tombstone",prev:null,sig:"x"},{type:"plc_operation",prev:"bafy",sig:"x"},{type:"plc_operation",prev:null}])
    await expect(genesisIdentity(invalid)).rejects.toThrow();
});

it("accepts provider records only from the pinned monitor and applies the newest record",async()=>{
  const f=await signupFixture(),now=Math.floor(Date.now()/1000);
  const record={...f.provider,issuedAt:now};
  const bytes=new TextEncoder().encode(JSON.stringify({type:"hail.plc-monitor-receiver-provider",version:1,providerId:record.providerId,
    providerOrigin,webOrigin,tokenHash:await hash(newToken()),enabled:true,issuedAt:now+1}));
  const forged=new MonitorSigner(generateKeyPairSync("ed25519").privateKey);
  for(const [key,sign] of [[forged.publicDidKey,forged.signReceiverProvider(bytes)],[f.signer.publicDidKey,forged.signReceiverProvider(bytes)],
    [f.signer.publicDidKey,f.signer.signAlert(bytes)]] as const)
    expect((await worker.fetch(new Request("https://alerts.plcmonitor.us/hail/providers",{method:"POST",headers:{"Content-Type":"application/json",
      "X-Hail-Monitor-Key":key,"X-Hail-Monitor-Signature":encodeBase64Url(sign)},body:bytes}),f.env)).status).toBe(401);
  expect((await provision(f.signer,f.env,{...record,issuedAt:now-1000})).status).toBe(400); // outside the five-minute window
  // Rotation: the new token works, the old one stops working, and an older record cannot restore it.
  const rotated=newToken();
  expect((await provision(f.signer,f.env,{...record,token:rotated,issuedAt:now+1})).status).toBe(204);
  expect((await f.post("/signup-email",{...f.identity,email:"alice@example.com"})).status).toBe(401);
  expect((await f.post("/signup-email",{...f.identity,email:"alice@example.com"},rotated)).status).toBe(200);
  expect((await provision(f.signer,f.env,{...record,issuedAt:now})).status).toBe(204);
  expect((await f.post("/signup-email",{...f.identity,email:"alice@example.com"})).status).toBe(401);
  // Disabling a provider refuses its requests; another provider cannot claim its token.
  expect((await provision(f.signer,f.env,{...record,token:rotated,enabled:false,issuedAt:now+2})).status).toBe(204);
  expect((await f.post("/signup-email",{...f.identity,email:"alice@example.com"},rotated)).status).toBe(401);
  expect((await provision(f.signer,f.env,{providerId:crypto.randomUUID(),providerOrigin:"https://svr.thief.example",webOrigin:null,token:rotated})).status).toBe(409);
  expect((await provision(f.signer,f.env,{...record,providerOrigin:"https://svr.moved.example",token:rotated,issuedAt:now+3})).status).toBe(409);
});

it("isolates providers' signups and refuses binding a DID registered at another provider",async()=>{
  const f=await signupFixture(),other={providerId:crypto.randomUUID(),providerOrigin:"https://svr.other.example",webOrigin:null,token:newToken()};
  expect((await provision(f.signer,f.env,other)).status).toBe(204);
  await f.post("/signup-email",{...f.identity,email:"alice@example.com"});
  const code=f.challenge();
  // The other provider cannot verify or resend this provider's signup.
  expect((await f.post("/signup-email/verify",{...f.identity,code},other.token)).status).toBe(409);
  expect((await f.post("/signup-email/verify",{...f.identity,code})).status).toBe(200);
  // The other provider verifies its own email, then tries to bind this provider's DID.
  const victim=await genesis();
  await f.post("/signup-email",{...f.identity,email:"mallory@example.com"},other.token);
  await f.post("/signup-email/verify",{...f.identity,code:f.challenge()},other.token);
  expect((await f.post("/signup-email/bind",{...f.identity,...victim},other.token)).status).toBe(400);
  // A tombstone written without a binding cannot block the real provider.
  expect((await f.post("/signup-email/remove-monitoring",{did:victim.did,operationCid:victim.operationCid},other.token)).status).toBe(204);
  expect((await f.post("/signup-email/bind",{...f.identity,...victim})).status).toBe(200);
  expect(f.coordinator.values.get(`recipient:${victim.did}`)).toMatchObject({email:"alice@example.com",providerId:f.provider.providerId});
  // Its own provider's tombstone does block it.
  const own=await genesis("https://svr.other.example"),fresh={signupId:crypto.randomUUID(),signupHash:f.identity.signupHash};
  expect((await f.post("/signup-email/remove-monitoring",{did:own.did,operationCid:own.operationCid},other.token)).status).toBe(204);
  await f.post("/signup-email",{...fresh,email:"bob@example.com"},other.token);
  await f.post("/signup-email/verify",{...fresh,code:f.challenge()},other.token);
  expect((await f.post("/signup-email/bind",{...fresh,...own},other.token)).status).toBe(409);
});

it("emails the fixed operator-verification template once per signed request",async()=>{
  const f=await signupFixture(),now=Math.floor(Date.now()/1000);
  const verification=(body:Record<string,unknown>,sign=(bytes:Uint8Array)=>f.signer.signOperatorVerification(bytes))=>{
    const bytes=new TextEncoder().encode(JSON.stringify(body));
    return worker.fetch(new Request("https://alerts.plcmonitor.us/hail/operator-verification",{method:"POST",headers:{"Content-Type":"application/json",
      "X-Hail-Monitor-Key":f.signer.publicDidKey,"X-Hail-Monitor-Signature":encodeBase64Url(sign(bytes))},body:bytes}),f.env);
  };
  const body={type:"hail.plc-monitor-operator-verification",version:1,email:"ops@provider.example",code:"12345678",
    providerOrigin:"https://svr.new.example",expiresAt:now+600,issuedAt:now};
  expect((await verification(body,bytes=>f.signer.signReceiverProvider(bytes))).status).toBe(401);
  expect((await verification({...body,html:"<p>arbitrary</p>"})).status).toBe(400);
  expect((await verification({...body,expiresAt:now+86400})).status).toBe(400);
  expect((await verification(body)).status).toBe(204);
  expect((await verification(body)).status).toBe(204);
  expect(f.send).toHaveBeenCalledOnce();
  expect(f.send.mock.calls[0]![0]).toMatchObject({to:"ops@provider.example",from:{email:"welcome@notify.racrproto.com",name:"Hail"},
    subject:"Verify your Hail provider registration"});
  expect(f.send.mock.calls[0]![0].text).toContain("is: 12345678");
  expect(f.send.mock.calls[0]![0].text).toContain("https://svr.new.example");
  for(let i=0;i<4;i++)expect((await verification({...body,code:String(i).repeat(8)})).status).toBe(204);
  expect((await verification({...body,code:"99999999"})).status).toBe(429); // mailbox limit
});

it("assigns recipients bound before v2 to the configured legacy provider when it is provisioned",async()=>{
  const f=await signupFixture(),legacy={did:`did:plc:${"l".repeat(24)}`,operationCid:(await cidForCbor({legacy:true})).toString()};
  f.coordinator.values.set(`recipient:${legacy.did}`,{...legacy,signupId:"old",signupHash:"hash",email:"early@example.com",verifiedAt:1});
  const haili={providerId:crypto.randomUUID(),providerOrigin:"https://svr.haili.example",webOrigin:"https://haili.example",token:newToken()};
  expect((await provision(f.signer,f.env,haili)).status).toBe(204);
  expect(f.coordinator.values.get(`recipient:${legacy.did}`)).not.toHaveProperty("providerId");
  f.env.LEGACY_RECIPIENT_PROVIDER_ORIGIN=haili.providerOrigin;
  expect((await provision(f.signer,f.env,{...haili,issuedAt:Math.floor(Date.now()/1000)+1})).status).toBe(204);
  expect(f.coordinator.values.get(`recipient:${legacy.did}`)).toMatchObject({providerId:haili.providerId,email:"early@example.com"});
  expect((await f.post("/signup-email/remove-monitoring",legacy)).status).toBe(409); // not this fixture's provider
  expect((await f.post("/signup-email/remove-monitoring",legacy,haili.token)).status).toBe(204);
});
