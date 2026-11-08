import assert from "node:assert/strict";
import {writeFile,readFile,mkdir} from "node:fs/promises";
import {join} from "node:path";
export async function browserCases(binary:string,root:string,directory:string,provider:string,env:Record<string,string|undefined>,install:(handler:(r:Request)=>Promise<Response>)=>void){
 const id="019a0000-0000-7000-8000-000000000001",expiresAt="2030-01-01T00:00:00.000Z";
 const bin=join(directory,"bin");await mkdir(bin);
 const script=join(bin,"browser.ts");
 await writeFile(script,`const state=await Bun.file(process.env.TEST_BROWSER_STATE!).json(); await Bun.write(process.env.TEST_BROWSER_STATE+".opened",process.argv[2]); const url=new URL(state.redirectUri);url.searchParams.set("state",process.env.TEST_BAD_CALLBACK==="1"?"wrong":state.state);url.searchParams.set("code",state.code);if(process.env.TEST_BAD_CALLBACK==="duplicate")url.searchParams.append("state",state.state);const response=await fetch(url);if(!process.env.TEST_BAD_CALLBACK&&!response.ok)process.exit(1);`);
 await writeFile(join(bin,"xdg-open"),`#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,{mode:0o700});
 let cases=0;
 for(const [index,command] of [[binary]].entries()){
  const path=join(directory,`browser-${index}.state`),output=join(directory,`browser-${index}.credential`);
  let prepared:any,fail="token",calls:any[]=[],credential:any,authorizationPath="/auth/authorize";
  install(async(request)=>{
   assert.equal(request.headers.get("cookie"),null);
   const route=new URL(request.url).pathname;
   const json=(v:unknown)=>new Response(JSON.stringify(v),{headers:{"Content-Type":"application/json"}});
   if(route === "/api/v1/account") {
    assert.equal(request.headers.get("authorization"),`Bearer ${credential.token}`);
    return json({type:"racr.account",version:1,provider,accountId:id,did:`did:plc:${"a".repeat(24)}`,
      address:"alice@independent.example",custodyProfile:"owner-controlled",migrationState:null,
      monitorVerificationMode:null,managedProfileVersion:null,identityPublicKey:"did:key:z123",
      ownerRecoveryPublicKey:null,scopes:["account:read"]});
   }
   assert.equal(request.headers.get("authorization"),null);
   const body=await request.json();calls.push({route,body});
   if(route.endsWith("/prepare")){
    if(fail==="interaction")return new Response("",{status:403,headers:{"Hail-Error-Code":"INTERACTION_REQUIRED"}});
    prepared=body;assert.equal(body.clientId,"racr-cli-v1");assert.deepEqual(body.scopes,["account:read"]);
    const url=new URL(`${provider}${authorizationPath}?request=${id}&state=${body.state}#code=${body.code}`);
    if(fail==="origin")url.hostname="wrong.example";
    if(fail==="userinfo")url.username="someone";
    if(fail==="duplicate")url.searchParams.append("state",body.state);
    if(fail==="request")url.searchParams.set("request","invalid");
    if(fail==="fragment")url.hash="code=wrong";
    return json({requestId:fail==="request"?"invalid":id,expiresAt:new Date(Date.now()+120000).toISOString(),authorizationUrl:url.href});
   }
   assert.equal(route,"/api/v1/auth/authorization/token");
   assert.equal(body.code,prepared.code);assert.equal(body.redirectUri,prepared.redirectUri);
   assert.equal(new Bun.CryptoHasher("sha256").update(body.verifier).digest("base64url"),prepared.codeChallenge);
   if(fail==="token")return new Response("",{status:503});
   credential={type:"racr.api-credential",version:1,provider,accountId:id,credentialId:id,token:body.token,scopes:["account:read"],expiresAt};
   return json(fail==="ack"?{...credential,scopes:["credentials:write"]}:credential);
  });
  async function run(success:boolean,state=path,out=output,bad:boolean|"duplicate"=false,scope="account:read"){
   const child=Bun.spawn([...command,"--json","account","browser-login","--provider",provider,"--state",state,"--credentials",out,"--scope",scope],{env:{...env,RACR_CREDENTIAL_FILE:"",PATH:`${bin}:${env.PATH}`,TEST_BROWSER_STATE:state,TEST_BAD_CALLBACK:bad==="duplicate"?bad:bad?"1":""},stdout:"pipe",stderr:"pipe"});
   let timedOut=false;const timeout=setTimeout(()=>{timedOut=true;child.kill();},10000);
   const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);clearTimeout(timeout);
   assert.equal(timedOut,false,"browser test timed out");
   assert.equal(code===0,success,stderr);
   if(fail==="interaction")assert.equal(JSON.parse(stderr).error.code,"INTERACTION_REQUIRED");
   if(await Bun.file(state).exists()){const saved=JSON.parse(await readFile(state,"utf8"));for(const key of ["token","code","verifier"])assert(!(stdout+stderr).includes(saved[key]));}cases++;
  }
  await run(false);const state=JSON.parse(await readFile(path,"utf8"));assert.equal(state.approved,true);
  fail="ack";await run(false);assert.equal(await Bun.file(output).exists(),false);
  fail="";await run(true);await run(true);assert.deepEqual(JSON.parse(await readFile(output,"utf8")),credential);
  assert.equal(calls.filter(c=>c.route.endsWith("/prepare")).length,1);
  await run(false,path,output,false,"credentials:write");
  await writeFile(output,"{}");await run(false);assert.equal(await readFile(output,"utf8"),"{}");
  await writeFile(path,JSON.stringify({...state,createdAt:0}));const before=calls.length;await run(false);assert.equal(calls.length,before);
  for(const rejected of ["origin","userinfo","duplicate","request","fragment","interaction"]){
   fail=rejected;const count=calls.length;
   await run(false,path+"-"+rejected,output+"-"+rejected);
   assert.equal(calls.length,count+1,"invalid authorization must not exchange a token");
   assert.equal(await Bun.file(path+"-"+rejected+".opened").exists(),false,"invalid URL must not open the browser");
  }
  fail="";authorizationPath="/company/sso/approve";
  const independent=output+"-independent";
  await run(true,path+"-independent",independent);
  assert.equal(new URL(await Bun.file(path+"-independent.opened").text()).pathname,authorizationPath);
  const child=Bun.spawn([binary,"account","show","--credentials",independent],{env,stdout:"pipe",stderr:"pipe"});
  const [exit,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  assert.equal(exit,0,stderr);assert.equal(JSON.parse(stdout).address,"alice@independent.example");
  assert(!stdout.includes(credential.token));cases++;

  fail="";await run(false,path+"-bad",output+"-bad",true);assert.equal(await Bun.file(output+"-bad").exists(),false);
  await run(false,path+"-duplicate-callback",output+"-duplicate-callback","duplicate");
  assert.equal(await Bun.file(output+"-duplicate-callback").exists(),false);
 }
 console.log(`Browser PKCE regression: ${cases} cases passed`);
}
