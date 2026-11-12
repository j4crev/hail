import {afterEach,expect,it,vi} from "vitest";
import {AccountApiClient,AccountApiError} from "@racrproto/client-support/account-api";
import {ClientError} from "@racrproto/client-support/client-error";
import {withClientAddress,clientAddress} from "./server/client-address.js";
import {providerBusy} from "./server/provider-busy.js";

const provider="https://provider.example",token="hails_"+"A".repeat(43),capability="https://racrproto.com/ns/jmap/account";
const json=(value:unknown,init:ResponseInit={})=>new Response(JSON.stringify(value),{...init,headers:{"Content-Type":"application/json",...init.headers}});
const view=(body:string)=>{const [name,,tag]=JSON.parse(body).methodCalls[0];return json({methodResponses:[[name,{accountId:"a_fixture",unread:1},tag]]});};
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});

it("forwards a valid browser address and reads the JMAP Session once per client",async()=>{
  const request=vi.fn(async(url:string,init?:RequestInit)=>{
    expect(init?.headers).toMatchObject({"X-Hail-Trusted-Client-IP":"2001:db8::7"});
    return url.endsWith("/.well-known/jmap")?json({primaryAccounts:{[capability]:"a_fixture"}}):view(String(init?.body));
  });
  vi.stubGlobal("fetch",request);
  const client=AccountApiClient.fromSession(provider,token,provider,provider,"2001:db8::7");
  await Promise.all([client.jmap("HailMailbox/view",{view:"unreadCounts"}),client.jmap("HailEmailAlias/get",{summary:true})]);
  expect(request.mock.calls.filter(([url])=>url.endsWith("/.well-known/jmap"))).toHaveLength(1);
  expect(request).toHaveBeenCalledTimes(3);
});

it("never forwards an invalid address",async()=>{
  const request=vi.fn(async(url:string,init?:RequestInit)=>{
    expect(init?.headers).not.toHaveProperty("X-Hail-Trusted-Client-IP");
    return url.endsWith("/.well-known/jmap")?json({primaryAccounts:{[capability]:"a_fixture"}}):view(String(init?.body));
  });
  vi.stubGlobal("fetch",request);
  await AccountApiClient.fromSession(provider,token,provider,provider,"10.0.0.1, 1.2.3.4").jmap("HailMailbox/view",{view:"unreadCounts"});
  expect(request).toHaveBeenCalledTimes(2);
});

it("retries the provider's concurrency refusal but not a rate limit",async()=>{
  let refusals=1;
  vi.stubGlobal("fetch",vi.fn(async(url:string,init?:RequestInit)=>{
    if(url.endsWith("/.well-known/jmap"))return json({primaryAccounts:{[capability]:"a_fixture"}});
    if(refusals-->0)return json({type:"limit"},{status:429});
    return view(String(init?.body));
  }));
  await expect(AccountApiClient.fromSession(provider,token).jmap("HailMailbox/view",{view:"unreadCounts"})).resolves.toMatchObject({unread:1});

  const limited=vi.fn(async(url:string)=>url.endsWith("/.well-known/jmap")?json({primaryAccounts:{[capability]:"a_fixture"}}):json({type:"limit"},{status:429,headers:{"Retry-After":"42"}}));
  vi.stubGlobal("fetch",limited);
  await expect(AccountApiClient.fromSession(provider,token).jmap("HailMailbox/view",{view:"unreadCounts"})).rejects.toMatchObject({status:429,retryAfterSeconds:42});
  expect(limited).toHaveBeenCalledTimes(2);
});

it("keeps each request's browser address separate",async()=>{
  const seen=await Promise.all(["192.0.2.1","not-an-ip"].map(address=>
    withClientAddress(new Request("https://gui.example/",{headers:{"X-Hail-Trusted-Client-IP":address}}),async()=>{await Promise.resolve();return clientAddress();})));
  expect(seen).toEqual(["192.0.2.1",null]);
  expect(clientAddress()).toBeNull();
});

it("treats provider rate limits, overload and transport failures as temporary",()=>{
  expect(providerBusy(new AccountApiError(429,42))).toBe(42);
  expect(providerBusy(new AccountApiError(503))).toBe(5);
  expect(providerBusy(new AccountApiError(429,300))).toBe(60);
  expect(providerBusy(new ClientError("TRANSPORT_ERROR","down"))).toBe(5);
  expect(providerBusy(new AccountApiError(500))).toBeNull();
  expect(providerBusy(new Error("parse"))).toBeNull();
});
