import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {strict as assert} from 'node:assert';
const sharedMode=process.argv.includes('--shared');
const work=await mkdtemp('/tmp/haili-layout-');
const reserve=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response()});
const fixturePort=reserve.port!;reserve.stop(true);
const fixture=Bun.spawn(['bun','scripts/preview-design.ts'],{cwd:new URL('..',import.meta.url).pathname,env:{...process.env,HAIL_DESIGN_PORT:String(fixturePort),HAIL_DESIGN_EXTRA_REPLIES:"0",HAIL_DESIGN_SHARED_CONVERSATIONS:sharedMode?"1":"0"},stdout:'ignore',stderr:'inherit'});
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
// Require the same typed mailbox fixture used by the built client before checking refresh UI.
const capability='https://racrproto.com/ns/jmap/account';
const sessionResponse=await fetch(origin+'/api/jmap/session');assert(sessionResponse.ok);
const session=await sessionResponse.json(),accountId=session.primaryAccounts[capability];
assert.equal(typeof accountId,'string');
const countsResponse=await fetch(origin+'/api/jmap',{method:'POST',headers:{'Content-Type':'application/json'},
 body:JSON.stringify({using:['urn:ietf:params:jmap:core',capability],methodCalls:[['HailMailbox/view',{accountId,view:'unreadCounts'},'refresh-fixture']]})});
assert(countsResponse.ok);
const [counts]= (await countsResponse.json()).methodResponses;
assert.equal(counts[0],'HailMailbox/view');assert.equal(counts[1].accountId,accountId);assert.equal(counts[2],'refresh-fixture');
assert.equal(typeof counts[1].subscriptions,'number');assert.equal(typeof counts[1].connections,'number');


async function navigate(path:string,title:string){
 await cdp('Page.navigate',{url:origin+path});
 await wait(async()=>evaluate(`document.querySelector('main h1')?.textContent===${JSON.stringify(title)} && document.readyState==='complete' && getComputedStyle(document.body).fontFamily.includes('Inter')`));
 await evaluate('document.fonts.ready');
}

const visible=async(selector:string)=>evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return !!e&&e.getClientRects().length>0&&getComputedStyle(e).display!=='none'})()`);
const notify=async()=>{
  await wait(async()=>evaluate(`document.querySelector('.desktop-refresh')?.getAttribute('aria-busy')==='false'`));
  await evaluate(`(()=>{const spacer=document.createElement('div');spacer.style.height='700px';spacer.id='test-scroll-space';document.querySelector('main').append(spacer);window.scrollTo(0,200);})()`);
  await wait(async()=>evaluate('scrollY>100'));
  await evaluate(`(()=>{const channel=new BroadcastChannel('hail-mailbox');channel.postMessage('changed');channel.close()})()`);
};
const geometry=()=>evaluate(`(()=>{
 const r=document.querySelector('.mobile-refresh').getBoundingClientRect();
 const p=document.querySelector('.mobile-compose,.mobile-cleanup')?.getBoundingClientRect();
 const m=document.querySelector('.mobile-header>.icon-button').getBoundingClientRect();
 const d=document.querySelector('.refresh-disc').getBoundingClientRect();
 const center=e=>({x:e.x+e.width/2,y:e.y+e.height/2});
 const overlap=(a,b)=>a.left<b.right&&b.left<a.right&&a.top<b.bottom&&b.top<a.bottom;
 return {refresh:center(r),primary:p?center(p):null,menu:center(m),target:[r.width,r.height],disc:[d.width,d.height],menuOverlap:overlap(r,m),primaryOverlap:p?overlap(r,p):false,barHeight:document.querySelector('.mobile-header').getBoundingClientRect().height,overflow:document.documentElement.scrollWidth>innerWidth};
})()`);
for(const width of [320,390,768]){
 await cdp('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:true});
 for(const [path,title] of [['/?view=subscriptions','Feed'],['/?view=connections','Inbox'],['/sent','Sent'],['/trash','Trash'],['/drafts','Drafts']]){
  await navigate(path,title);
  await wait(async()=>evaluate(`document.querySelector('.desktop-refresh')?.getAttribute('aria-busy')==='false'`));
  assert(!await visible('.mobile-refresh'),'No floating refresh without pending updates');
  const barHeight=await evaluate(`document.querySelector('.mobile-header').getBoundingClientRect().height`);
  await notify();
  await wait(async()=>visible('.mobile-refresh'));
  await evaluate("document.getElementById('test-scroll-space')?.remove();window.scrollTo(0,0)");
  const g=await geometry();
  assert.deepEqual(g.target,[44,44]);assert.deepEqual(g.disc,[40,40]);
  assert(!g.menuOverlap&&!g.primaryOverlap&&!g.overflow,JSON.stringify(g));
  assert.equal(g.barHeight,barHeight,'Bottom bar height stays unchanged');
  const primaryX=g.primary?.x??width/2;
  assert(Math.abs(g.refresh.x-(primaryX+g.menu.x)/2)<1,'Refresh is horizontally halfway to menu');
  if(g.primary)assert(Math.abs(g.refresh.y-g.primary.y)<1,'Floating centers align vertically');
  for(const scheme of ['light','dark']){
   await cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:scheme}]});
   assert(await evaluate(`(()=>{const s=getComputedStyle(document.querySelector('.refresh-disc'));return s.color!==s.backgroundColor})()`));
   if(width===390&&title==='Feed'){
    const shot=await cdp('Page.captureScreenshot',{format:'png'});await Bun.write('/tmp/hail-refresh-mobile-'+scheme+'.png',Buffer.from(shot.data,'base64'));
   }
  }
  if(width===390&&title==='Feed'){
   await wait(async()=>!(await visible('.refresh-hint')));
   assert(await visible('.mobile-refresh'),'The hint expires, but the update action remains');
   assert(await evaluate(`document.querySelector('.mobile-refresh').getAttribute('aria-label').includes('Updates available')`));
  }
  // Active selection hides the refresh target without changing the primary action.
  if(title==='Feed'){
   await evaluate(`document.querySelector('.selection-avatar').click()`);
   assert(!await visible('.mobile-refresh'));
   await evaluate(`document.querySelector('.selection-avatar').click()`);
   await wait(async()=>visible('.mobile-refresh'));
  }
  if(title==='Sent'){
   await evaluate(`document.querySelector('.mobile-cleanup').click()`);
   await wait(async()=>visible('.cleanup-confirmation'));
   assert(!await visible('.mobile-refresh'),'Cleanup confirmation suppresses refresh');
   await evaluate(`Array.from(document.querySelectorAll('.confirmation-actions button')).find(b=>b.textContent==='Cancel').click()`);
   await wait(async()=>visible('.mobile-refresh'));
  }
  await evaluate(`document.querySelector('.mobile-refresh').click()`);
  await wait(async()=>!(await visible('.mobile-refresh')));
  console.log('PASS: '+title+' floating refresh geometry and interaction at '+width+'px');
 }
}
await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
await cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'light'}]});
await navigate('/?view=subscriptions','Feed');
await notify();await wait(async()=>visible('.updates-pill'));
await evaluate("document.getElementById('test-scroll-space')?.remove();window.scrollTo(0,0)");
assert(!await visible('.mobile-refresh'));
assert(await evaluate(`(()=>{const h=document.querySelector('h1').getBoundingClientRect(),b=document.querySelector('.desktop-refresh').getBoundingClientRect();return b.top<h.bottom&&b.bottom>h.top})()`),'Desktop icon shares heading row');
const shot=await cdp('Page.captureScreenshot',{format:'png'});await Bun.write('/tmp/hail-refresh-desktop.png',Buffer.from(shot.data,'base64'));
console.log('PASS: desktop heading control and conditional updates pill');
}finally{socket?.close();chrome.kill();fixture.kill();await chrome.exited;await fixture.exited;await rm(work,{recursive:true,force:true});}
