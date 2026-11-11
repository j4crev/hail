// Built-client boundary test: two loopback origins, fictional credentials, no browser or public services.
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../../server/src/app.js';
import type {AppConfig} from '../../server/src/config.js';
import type {AppDependencies} from '../../server/src/app.js';

const work=await mkdtemp(join(tmpdir(),'hail-origin-proof-'));
const session='hails_'+'A'.repeat(43),signup='racr_'+'B'.repeat(43);
const did='did:plc:'+'a'.repeat(24),id='01900000-0000-7000-8000-000000000001',digest='C'.repeat(43);
const reserve=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response()});
const guiPort=reserve.port;
const guiOrigin=`http://localhost:${guiPort}`;
let app:ReturnType<typeof createApp>;
const provider=Bun.serve({hostname:'127.0.0.1',port:0,fetch:request=>{
  const path=new URL(request.url).pathname;
  if(path==='/api/v1/auth/passkeys/authentication'){
    if(request.headers.get('Origin')!==guiOrigin)return Response.json({}, {status:403});
    return Response.json({authenticated:true},{headers:{'Set-Cookie':`hail_session=${session}; HttpOnly; SameSite=Lax; Path=/`}});
  }
  if(path==='/api/v1/signup-email/start')return Response.json({accepted:request.headers.get('Authorization')===`Bearer ${signup}`&&request.headers.get('Origin')===guiOrigin});
  if(path==='/api/v1/account/fixture-html')return new Response('<script>bad()</script>',{headers:{'Content-Type':'text/html'}});
  return app.fetch(request);
}});
const providerOrigin=`http://localhost:${provider.port}`;
assert.notEqual(provider.port,guiPort,'Provider and GUI must have separate listening ports');
let active=true;
app=createApp({publicOrigin:providerOrigin,providerId:'fixture',passkeys:{origin:guiOrigin,rpId:'localhost'}} as AppConfig,{
  accountApi:{accounts:{authenticate:async(_authorization:string,cookie:string)=>active&&cookie===session?{
    account_id:'01900000-0000-7000-8000-000000000002',did,scopes:['messages:read'],serving_generation:1}:null},grants:{},service:{},
    messaging:{attachment:async()=>({file:{filename:'fixture.txt',media_type:'text/plain'},bytes:new TextEncoder().encode('private fixture attachment')})},
    avatarProfiles:{findCurrentByDid:async()=>({
      payload:{version:2,assets:{assets:[{role:'avatar',data:new Uint8Array([137,80,78,71]),width:1,height:1}]}}
    })}
  }
} as unknown as AppDependencies);
// Keep the GUI port reserved until the provider is listening, so its ephemeral
// allocation cannot reuse the GUI port. Finish closing before the child binds.
await reserve.stop(true);
const child=Bun.spawn(['bun','build/index.js'],{cwd:new URL('..',import.meta.url).pathname,
  env:{...process.env,PUBLIC_SENTRY_DSN:'',HOST:'127.0.0.1',PORT:String(guiPort),ORIGIN:guiOrigin,HAIL_WEB_CLIENT_PROVIDER:providerOrigin,
    HAIL_WEB_CLIENT_ORIGIN:guiOrigin,HAIL_WEB_CLIENT_API_ORIGIN:providerOrigin,HAIL_WEB_CLIENT_SIGNUP:'false'},
  stdout:'ignore',stderr:Bun.file(join(work,'gui.log'))});
try{
  let ready=false;
  for(let attempt=0;attempt<150;attempt++){
    try{if((await fetch(guiOrigin)).ok){ready=true;break;}}catch{}
    await Bun.sleep(100);
  }
  assert(ready,'GUI startup failed: '+await readFile(join(work,'gui.log'),'utf8'));
  const login=await fetch(`${guiOrigin}/api/v1/auth/passkeys/authentication`,{method:'POST',headers:{Origin:guiOrigin,'Content-Type':'application/json'},body:'{}'});
  assert.equal(login.status,200);assert(login.headers.get('set-cookie')?.includes(`hail_session=${session}`));
  assert(!/;\s*domain=/i.test(login.headers.get('set-cookie')!));
  const signupResult=await fetch(`${guiOrigin}/api/v1/signup-email/start`,{method:'POST',headers:{Origin:guiOrigin,Authorization:`Bearer ${signup}`,'Content-Type':'application/json'},body:'{}'});
  assert.equal((await signupResult.json()).accepted,true,'Scoped signup authorization must survive the bridge');
  const headers={Cookie:`hail_session=${session}`};
  const attachmentPath=`/attachments/${encodeURIComponent(did)}/${id}/${digest}?index=0`;
  const redirect=await fetch(guiOrigin+attachmentPath,{headers,redirect:'manual'});
  assert.equal(redirect.status,303);assert.equal(await redirect.text(),'');
  const location=new URL(redirect.headers.get('location')!);assert.equal(location.origin,providerOrigin);
  assert(!location.href.includes(session));assert.match(redirect.headers.get('cache-control')!,/no-store/);
  const downloaded=await fetch(location);assert.equal(downloaded.status,200);
  assert.equal(await downloaded.text(),'private fixture attachment');
  assert.equal(downloaded.headers.get('set-cookie'),null);
  const avatar=await fetch(`${guiOrigin}/media/avatars/${encodeURIComponent(did)}`,{headers,redirect:'manual'});
  assert.equal(avatar.status,303);assert.equal(new URL(avatar.headers.get('location')!).origin,providerOrigin);
  const image=await fetch(avatar.headers.get('location')!);assert.equal(image.headers.get('content-type'),'image/png');
  for(const path of [location.pathname,`/api/v1/account/attachments/${did}/${id}/${digest}`,`/api/v1/account/senders/${did}/avatar/image`]){
    assert.equal((await fetch(guiOrigin+path,{headers})).status,404);
  }
  assert.equal((await fetch(`${guiOrigin}/api/v1/account/fixture-html`,{headers})).status,502);
  assert.equal((await fetch(`${providerOrigin}/api/v1/account/attachments/${did}/${id}/${digest}`)).status,401);
  active=false;assert.equal((await fetch(location)).status,401,'Revocation must invalidate issued capabilities');
  console.info('PASS: separate-origin HTTP login, scoped signup token, host-only cookie, media redirects, JSON boundary and revocation');
}finally{
  child.kill();await child.exited;provider.stop(true);await rm(work,{recursive:true,force:true});
}
