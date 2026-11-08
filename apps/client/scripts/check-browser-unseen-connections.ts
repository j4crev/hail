import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {strict as assert} from 'node:assert';
const work=await mkdtemp('/tmp/haili-layout-');
const reserve=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response()});
const fixturePort=reserve.port!;reserve.stop(true);
const fixture=Bun.spawn(['bun','scripts/preview-design.ts'],{cwd:new URL('..',import.meta.url).pathname,env:{...process.env,HAIL_DESIGN_PORT:String(fixturePort),HAIL_DESIGN_UNSEEN_CONNECTIONS:"1",HAIL_DESIGN_EXTRA_REPLIES:"0",HAIL_DESIGN_EMPTY_RELATIONSHIPS:"0",HAIL_DESIGN_SHARED_CONVERSATIONS:"0"},stdout:'ignore',stderr:'inherit'});
const chrome=Bun.spawn([process.env.CHROMIUM??'chromium','--headless','--disable-gpu','--disable-background-networking','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${work}`,'about:blank'],{stdout:'ignore',stderr:'ignore'});
let socket:WebSocket|undefined;
const wait=async(fn:()=>Promise<any>)=>{for(let n=0;n<150;n++){if(await fn())return;await Bun.sleep(100);}throw new Error('Timed out: '+fn.toString());};
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

// Hold the acknowledgment to inspect the exact rendered group before the count clears.
await cdp('Page.addScriptToEvaluateOnNewDocument',{source:`
  const originalFetch=window.fetch;
  window.fetch=async(...args)=>{
    if(String(args[0]).endsWith('/connections/seen')){
      window.seenPayload=JSON.parse(args[1].body);
      await new Promise(resolve=>window.releaseSeen=resolve);
      if(!window.seenFailed){window.seenFailed=true;window.releaseSeen=null;return Response.json({error:"Try again"},{status:503});}
    }
    return originalFetch(...args);
  };
`});
await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
await navigate('/?view=connections','Inbox');
await wait(async()=>evaluate(`document.querySelector('.mobile-header button')?.getAttribute('aria-label')==='Open navigation, 2 unseen connections'`));
assert(await evaluate(`!!document.querySelector('.navigation-dot')`),'Mobile navigation advertises unseen connections');
await navigate('/connections','Connections');
await wait(async()=>evaluate(`!!window.releaseSeen`));
assert.equal(await evaluate(`document.querySelector('.new-connections h3').textContent`),'New connections');
assert.equal(await evaluate(`document.querySelectorAll('.new-connections .list-row').length`),2);
assert.equal(await evaluate(`document.querySelectorAll('.connection-group:not(.new-connections) .list-row').length`),1);
assert.equal(await evaluate(`document.querySelectorAll('.list-row.is-selected').length`),0,'New rows do not look selected');
assert.equal(await evaluate(`window.seenPayload.connections.length`),2,'Only rendered unseen identities are acknowledged');
assert(await evaluate(`window.seenPayload.connections.every(c=>c.epoch===1)`));
await evaluate(`document.querySelector('.new-connections button[aria-pressed]').click()`);
assert.equal(await evaluate(`document.querySelectorAll('.list-row.is-selected').length`),1,'Selection is independent');
await evaluate(`window.releaseSeen()`);
await wait(async()=>evaluate(`window.seenFailed===true`));
assert(await evaluate(`!!document.querySelector('.navigation-dot')`),'Failed acknowledgment retains the count');
await evaluate(`document.querySelector('[aria-label="Clear selection"]').click();window.dispatchEvent(new Event('focus'))`);
await wait(async()=>evaluate(`!!window.releaseSeen`));
await evaluate(`window.releaseSeen()`);
await wait(async()=>evaluate(`!document.querySelector('.navigation-dot')`));
assert.equal(await evaluate(`document.querySelectorAll('.new-connections .list-row').length`),2,'Grouping survives acknowledgment');
// A second page load sees the server acknowledgment, like another device.
await navigate('/connections','Connections');
await wait(async()=>evaluate(`document.querySelectorAll('.list-row').length===3`));
assert.equal(await evaluate(`document.querySelectorAll('.new-connections').length`),0,'Seen connections are ordinary on the next visit');
await cdp('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
assert.equal(await evaluate(`document.querySelectorAll('.sidebar [aria-label="2 unseen connections"]').length`),0);
console.log('PASS: mobile dot, new-first grouping, independent selection, exact acknowledgment and persistent clearing');
}finally{socket?.close();chrome.kill();fixture.kill();await Promise.all([chrome.exited,fixture.exited]);await rm(work,{recursive:true,force:true});}
