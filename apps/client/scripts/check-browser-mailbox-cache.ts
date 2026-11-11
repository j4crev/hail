import {fixtureMessageMutation} from './jmap-read-fixture.js';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {strict as assert} from 'node:assert';
async function fixtureOperation(origin:string,name:string,args:Record<string,unknown>={}){
 const capability='https://racrproto.com/ns/jmap/account';
 const sessionResponse=await fetch(origin+'/api/jmap/session');assert(sessionResponse.ok);
 const session=await sessionResponse.json(),accountId=session.primaryAccounts[capability];
 assert.equal(typeof accountId,'string');assert(session.accounts[accountId].accountCapabilities[capability]);
 const response=await fetch(origin+'/api/jmap',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({using:['urn:ietf:params:jmap:core',capability],methodCalls:[[name,{...args,accountId},'fixture']]})});
 assert(response.ok);
 const envelope=await response.json();assert.equal(envelope.methodResponses.length,1);
 const [method,result,tag]=envelope.methodResponses[0];
 assert.equal(method,name,JSON.stringify(result));assert.equal(tag,'fixture');assert.equal(result.accountId,accountId);
 return result;
}
const sharedMode=process.argv.includes('--shared');
const work=await mkdtemp('/tmp/haili-layout-');
const reserve=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response()});
const fixturePort=reserve.port!;reserve.stop(true);
const fixture=Bun.spawn(['bun','scripts/preview-design.ts'],{cwd:new URL('..',import.meta.url).pathname,env:{...process.env,HAIL_DESIGN_PORT:String(fixturePort),HAIL_DESIGN_EXTRA_REPLIES:"0",HAIL_DESIGN_PAGE_SIZE:"2",HAIL_DESIGN_SHARED_CONVERSATIONS:sharedMode?"1":"0"},stdout:'ignore',stderr:'inherit'});
const chrome=Bun.spawn([process.env.CHROMIUM??'chromium','--headless','--disable-gpu','--disable-background-networking','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${work}`,'about:blank'],{stdout:'ignore',stderr:'ignore'});
let socket:WebSocket|undefined;
const wait=async(fn:()=>Promise<any>)=>{for(let n=0;n<150;n++){if(await fn())return;await Bun.sleep(100);}throw new Error('Timed out: '+fn);};
try{
let port='';await wait(async()=>{try{port=(await readFile(work+'/DevToolsActivePort','utf8')).split('\n')[0];return port;}catch{return false;}});
const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();socket=new WebSocket(targets.find((t:any)=>t.type==='page').webSocketDebuggerUrl);
await new Promise<void>(resolve=>socket!.onopen=()=>resolve());
let id=0;const pending=new Map<number,any>();socket.onmessage=event=>{const v=JSON.parse(String(event.data));if(pending.has(v.id)){const p=pending.get(v.id);pending.delete(v.id);v.error?p.reject(v.error):p.resolve(v.result);}};
const cdp=(method:string,params:unknown={})=>new Promise<any>((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});socket!.send(JSON.stringify({id:n,method,params}));});
const evaluate=async(expression:string)=>{const r=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
await cdp('Page.enable');await cdp('Runtime.enable');
const origin=`http://localhost:${fixturePort}`;
// The fixture API starts before the GUI; wait for rendered HTML before navigating.
await wait(async()=>{try{return (await fetch(origin+'/?view=connections')).ok;}catch{return false;}});

async function navigate(path:string,title:string){
 await cdp('Page.navigate',{url:origin+path});
 await wait(async()=>evaluate(`document.querySelector('main h1')?.textContent===${JSON.stringify(title)} && document.readyState==='complete' && getComputedStyle(document.body).fontFamily.includes('Inter')`));
 await evaluate('document.fonts.ready');
}

const click=async(label:string)=>evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.getClientRects().length&&(b.getAttribute('aria-label')??b.textContent.trim())===${JSON.stringify(label)}).click()`);
await navigate('/?view=subscriptions','Feed');
await wait(async()=>evaluate(`Array.from(document.querySelectorAll('button')).some(b=>b.getAttribute('aria-label')==='Refresh messages'&&!b.disabled)`));
const rows=()=>evaluate(`document.querySelectorAll('.message-row').length`);
assert.equal(await rows(),2);
await click('Load older');await wait(async()=>await rows()>2);
const expanded=await rows();assert(expanded>2);
await evaluate(`document.querySelector('nav[aria-label="Main navigation"] a[href="/sent"]').click()`);
await wait(async()=>evaluate(`document.querySelector('main h1')?.textContent==='Sent'`));
// A slow background request must not block a warm folder revisit.
await evaluate(`window.realFetch=window.fetch;window.fetch=async(...args)=>{if(String(args[0]).startsWith('/mailbox-data'))await new Promise(r=>setTimeout(r,1500));return window.realFetch(...args)};document.querySelector('nav[aria-label="Main navigation"] a[href="/?view=subscriptions"]').click()`);
await Bun.sleep(300);
assert.equal(await evaluate(`document.querySelector('main h1')?.textContent`),'Feed');
assert.equal(await rows(),2);
await wait(async()=>evaluate(`Array.from(document.querySelectorAll('button')).some(b=>b.getAttribute('aria-label')==='Refresh messages'&&!b.disabled)`));
await evaluate('window.fetch=window.realFetch');
// An external mutation is detected without disturbing active selection.
await evaluate(`document.querySelector('.selection-avatar').click()`);
const first=(await fixtureOperation(origin,'HailMailbox/view',{view:'inboxFeed',channel:'subscriptions',after:null})).messages[0];
await fixtureMessageMutation(origin,first,{isInTrash:true});
await evaluate(`window.dispatchEvent(new Event('hail:mailbox-changed'))`);
await wait(async()=>evaluate(`document.querySelector('main').textContent.includes('Updates available')`));
assert.equal(await rows(),2);
assert(await evaluate(`document.querySelector('.selection-avatar').getAttribute('aria-pressed')==='true'`));
await evaluate(`document.querySelector('.selection-avatar').click()`);
await click('Updates available — refresh');
assert(!(await evaluate(`Array.from(document.querySelectorAll('.message-row a')).map(a=>a.href).join(' ')`)).includes(first.messageId));
// A same-tab mutation invalidates a warmed folder before navigation returns to it.
await evaluate(`document.querySelector('nav[aria-label="Main navigation"] a[href="/sent"]').click()`);
await wait(async()=>evaluate(`document.querySelector('main h1')?.textContent==='Sent'`));
await evaluate(`(${fixtureMessageMutation.toString()})(location.origin,${JSON.stringify(first)},{isInTrash:false})`);
await evaluate(`document.querySelector('nav[aria-label="Main navigation"] a[href="/?view=subscriptions"]').click()`);
await wait(async()=>evaluate(`document.querySelector('main h1')?.textContent==='Feed'`));
assert((await evaluate(`Array.from(document.querySelectorAll('.message-row a')).map(a=>a.href).join(' ')`)).includes(first.messageId));
// Opened message content also renders immediately on a warm revisit.
await evaluate(`document.querySelector('.message-link').click()`);
await wait(async()=>evaluate(`location.pathname.startsWith('/message/') && Boolean(document.querySelector('.reader-panel'))`));
await wait(async()=>evaluate(`Array.from(document.querySelectorAll('button')).some(b=>(b.getAttribute('aria-label')==='Refresh messages'||b.textContent.includes('Updates available'))&&!b.disabled)`));
await Bun.sleep(500);
const readerPath=await evaluate('location.pathname');
await evaluate(`document.querySelector('nav[aria-label="Main navigation"] a[href="/sent"]').click()`);
await wait(async()=>evaluate(`document.querySelector('main h1')?.textContent==='Sent'`));
await evaluate(`window.realFetch=window.fetch;window.fetch=async(...args)=>{if(String(args[0]).startsWith('/mailbox-data'))await new Promise(r=>setTimeout(r,1500));return window.realFetch(...args)};const a=document.createElement('a');a.href=${JSON.stringify(readerPath)};document.querySelector('main').append(a);a.click()`);
await Bun.sleep(300);
assert.equal(await evaluate('location.pathname'),readerPath);
assert(await evaluate(`Boolean(document.querySelector('.reader-panel'))`));
await evaluate('window.fetch=window.realFetch');
console.log('PASS: opened message cache renders before delayed revalidation');
console.log('PASS: accumulated history, immediate cached navigation, selection-safe refresh, mutation invalidation');
}finally{socket?.close();chrome.kill();fixture.kill();await chrome.exited;await fixture.exited;await rm(work,{recursive:true,force:true});}
