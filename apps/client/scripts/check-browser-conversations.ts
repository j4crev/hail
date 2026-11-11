import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {strict as assert} from 'node:assert';
const sharedMode=process.argv.includes('--shared');
const work=await mkdtemp('/tmp/haili-layout-');
const reserve=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response()});
const fixturePort=reserve.port!;reserve.stop(true);
const fixture=Bun.spawn(['bun','scripts/preview-design.ts'],{cwd:new URL('..',import.meta.url).pathname,env:{...process.env,HAIL_DESIGN_PORT:String(fixturePort),HAIL_DESIGN_EXTRA_REPLIES:sharedMode?"0":"35",HAIL_DESIGN_SHARED_CONVERSATIONS:sharedMode?"1":"0"},stdout:'ignore',stderr:'inherit'});
const chrome=Bun.spawn([process.env.CHROMIUM??'chromium','--headless','--disable-gpu','--disable-background-networking','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${work}`,'about:blank'],{stdout:'ignore',stderr:'ignore'});
let socket:WebSocket|undefined;
const wait=async(fn:()=>Promise<any>)=>{for(let n=0;n<150;n++){if(await fn())return;await Bun.sleep(100);}throw new Error('Timed out');};
try{
let port='';await wait(async()=>{try{port=(await readFile(work+'/DevToolsActivePort','utf8')).split('\n')[0];return port;}catch{return false;}});
const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();socket=new WebSocket(targets.find((t:any)=>t.type==='page').webSocketDebuggerUrl);
await new Promise<void>(resolve=>socket!.onopen=()=>resolve());
let id=0;const pending=new Map<number,any>();socket.onmessage=event=>{const v=JSON.parse(String(event.data));if(pending.has(v.id)){const p=pending.get(v.id);pending.delete(v.id);v.error?p.reject(v.error):p.resolve(v.result);}};
const cdp=(method:string,params:unknown={})=>new Promise<any>((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});socket!.send(JSON.stringify({id:n,method,params}));});
const evaluate=async(expression:string)=>{const r=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
await cdp('Page.enable');await cdp('Runtime.enable');
const origin=`http://localhost:${fixturePort}`;
const accountOperation=async(name:string,args:Record<string,unknown>={})=>{
 const capability='https://haili.app/ns/jmap/account';
 const sessionResponse=await fetch(origin+'/api/jmap/session');assert(sessionResponse.ok);
 const session=await sessionResponse.json(),accountId=session.primaryAccounts[capability];assert.equal(accountId,'fixture_account');
 const response=await fetch(origin+'/api/jmap',{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({using:['urn:ietf:params:jmap:core',capability],methodCalls:[[name,{accountId,...args},'scenario']]})});
 assert(response.ok);const result=(await response.json()).methodResponses[0];assert.equal(result[0],name,JSON.stringify(result));
 assert.equal(result[2],'scenario');return result[1];
};
// The fixture API starts before the GUI; wait for rendered HTML before navigating.
await wait(async()=>{try{return (await fetch(origin+'/?view=connections')).ok;}catch{return false;}});

async function navigate(path:string,title:string){
 await cdp('Page.navigate',{url:origin+path});
 await wait(async()=>evaluate(`(${JSON.stringify(path)}.startsWith('/compose')?!!document.querySelector('form.compose-layout'):document.querySelector('main h1')?.textContent===${JSON.stringify(title)}) && document.readyState==='complete' && getComputedStyle(document.body).fontFamily.includes('Inter')`));
 await evaluate('document.fonts.ready');
}

async function assertReadSettled(){
 await wait(async()=>evaluate(`document.querySelector('.expanded .action-menu button')?.disabled===false`));
 const state=()=>evaluate(`({reads:performance.getEntriesByType('resource').filter(e=>e.name.endsWith('/api/jmap')).length,selected:document.querySelector('.expanded')?.id,rows:document.querySelectorAll('.conversation-item').length})`);
 const before=await state();
 await Bun.sleep(500);
 assert.deepEqual(await state(),before,'Sidebar count refresh must not repeat mark-read, reset the selected message, or reset loaded rows');
}

const api=()=>accountOperation('HailMailbox/view',{view:'inboxFeed',channel:'connections'});
const grouped=()=>accountOperation('HailMailbox/view',{view:'connectionInbox'});
if(!sharedMode)for(const width of [1440,390,320]){
 const initial=await api();
 for(const m of initial.messages.filter((m:any)=>!m.body.blocks.some((b:any)=>b.children?.some((s:any)=>s.text==='The photos turned out beautifully')))){
  const capability='https://haili.app/ns/jmap/messages';
  const session=await (await fetch(`${origin}/api/jmap/session`)).json();const accountId=session.primaryAccounts[capability];
  const call=async(name:string,args:unknown)=>(await (await fetch(`${origin}/api/jmap`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({using:['urn:ietf:params:jmap:core',capability],methodCalls:[[name,args,'test']]})})).json()).methodResponses[0][1];
  const query=await call('HailMessage/query',{accountId,filter:{sender:m.sender,messageId:m.messageId,inTrash:false}});
  const result=await call('HailMessage/set',{accountId,ifInState:query.queryState,update:{[query.ids[0]]:{isRead:false}}});
  assert(result.updated?.[query.ids[0]]===null);
 }
 const inbox=await grouped(),oldest=inbox.messages[0];
 assert.equal(oldest.conversation.unreadCount,40);assert.equal(inbox.messages.length,2);
 await cdp('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<500});
 await navigate('/?view=connections','Inbox');
 await wait(async()=>evaluate(`document.querySelectorAll('.message-row').length===2`));
 assert(await evaluate(`document.querySelector('.message-row').textContent.includes('(40)')`));
 await evaluate(`document.querySelector('.message-row .message-link').click()`);
 await wait(async()=>evaluate(`document.querySelector('.expanded-body') && document.querySelector('.action-menu button')?.disabled===false`));
 assert.equal(await evaluate(`document.querySelector('.expanded').id`),'row-'+oldest.messageId);
 await wait(async()=>evaluate(`document.querySelectorAll('.conversation-item').length===34`));
 assert(await evaluate(`Array.from(document.querySelectorAll('.conversation-item')).filter(e=>!e.classList.contains('expanded')&&e.getBoundingClientRect().bottom>80&&e.getBoundingClientRect().bottom<=document.querySelector('.expanded').getBoundingClientRect().top).length>=2`),'Newer rows remain visible above the opened message');
 await assertReadSettled();
 assert.equal((await grouped()).messages[0].conversation.unreadCount,39);
 assert(await evaluate(`document.querySelector('.expanded').textContent.includes(${JSON.stringify(oldest.sender)})`));
 assert(await evaluate(`!Array.from(document.querySelectorAll('button')).some(b=>b.textContent.includes('unread above'))`),'Newer replies require no button');
 assert(await evaluate(`!document.querySelector('.expanded .message-row')`),'Expanded header replaces the list row');
 assert(await evaluate(`document.querySelector('main h1').textContent==='Saturday at the market?' && !document.querySelector('.conversation-item .message-subject') && !document.querySelector('.different-subject')`),'The shared subject appears once, without a Conversation heading');
 assert(await evaluate(`Math.abs(document.querySelector('.reading-body').getBoundingClientRect().left-document.querySelector('.expanded-header').getBoundingClientRect().left)<14`),'Reading column is aligned to the left');

 await evaluate(`document.querySelector('.message-details summary').click()`);
 assert.equal(await evaluate(`document.querySelector('.message-details time').dateTime`),new Date(oldest.deliveredAt).toISOString(),'Details uses the received timestamp');
 assert(await evaluate(`document.querySelector('.message-details time').textContent===new Intl.DateTimeFormat(undefined,{dateStyle:'long',timeStyle:'long'}).format(new Date(${JSON.stringify(oldest.deliveredAt)}))`),'Timestamp includes seconds and timezone');
 assert(await evaluate(`!document.querySelector('.message-details ul')`),'Direct messages have no participant list');
 assert(await evaluate(`document.documentElement.scrollWidth<=innerWidth`),'Expanded details fit the viewport');
 assert.equal(await evaluate(`document.querySelector('.expanded-header').textContent.split(${JSON.stringify(oldest.senderAddress)}).length-1`),1,'Sender address appears once');
 const originalTitle=await evaluate(`document.querySelector('.conversation-subject').textContent`);
 await evaluate(`document.querySelector('.conversation-subject').textContent='Saturday at the market — planning our morning together, choosing a meeting place, and everything we should bring along for a picnic afterward'`);
 assert(await evaluate(`(()=>{const h=document.querySelector('.conversation-subject'),s=getComputedStyle(h);return h.scrollHeight<=h.clientHeight+1 && s.whiteSpace==='normal' && document.querySelector('.expanded-date').getBoundingClientRect().right<=innerWidth;})()`),'Long conversation subjects remain fully visible');
 assert(await evaluate(`document.documentElement.scrollWidth<=innerWidth`));
 if(width<500)assert(await evaluate(`document.querySelector('.conversation-subject').clientHeight>parseFloat(getComputedStyle(document.querySelector('.conversation-subject')).lineHeight)*2`),'Mobile subject wraps across multiple lines');
 await evaluate(`document.querySelector('.conversation-subject').textContent=${JSON.stringify(originalTitle)}`);

 assert(await evaluate(`document.documentElement.scrollWidth<=innerWidth`));
 await evaluate(`window.scrollTo(0,0)`);
 await wait(async()=>evaluate(`document.querySelectorAll('.conversation-item').length===41`));
 await evaluate(`Array.from(document.querySelectorAll('.conversation-item')).at(-1).querySelector('button.row-button').click()`);
 await wait(async()=>evaluate(`document.querySelector('.expanded')?.textContent.includes('Delivery details')`));
 assert.equal(await evaluate(`document.querySelectorAll('.expanded-body').length`),1);
 assert.equal((await grouped()).messages[0].conversation.unreadCount,39);
 await evaluate(`document.querySelector('.conversation-item button.row-button').click()`);
 await wait(async()=> (await grouped()).messages[0].conversation.unreadCount===38);
 await assertReadSettled();
 assert(await evaluate(`document.querySelector('.expanded').textContent.includes('maya@')`));
 assert.equal(await evaluate(`document.querySelectorAll('.expanded-body').length`),1);
 assert(await evaluate(`document.documentElement.scrollWidth<=innerWidth`));
 await evaluate(`document.querySelector('.expanded .action-menu summary').click()`);
 await evaluate(`Array.from(document.querySelectorAll('.expanded .menu-item')).find(b=>b.textContent.includes('Mark unread')).click()`);
 await wait(async()=>evaluate(`location.pathname==='/' && location.search==='?view=connections' && document.querySelectorAll('.message-row').length===2`));
 assert.equal((await grouped()).messages[0].conversation.unreadCount,39,'Message remains unread after returning to Inbox');
 assert(await evaluate(`document.querySelector('.message-row').textContent.includes('(39)')`));
 await evaluate(`document.querySelector('.message-row .message-link').click()`);
 await wait(async()=> (await grouped()).messages[0].conversation.unreadCount===38);
 console.log('PASS: 40 unread replies load in bounded batches on scroll, with independent read state and sent original at '+width);
}
if(sharedMode){
  const all=await api(),maya=all.messages.find((m:any)=>m.sharedConversation&&!m.connection);
  assert(maya,'Fixture includes a non-connection participant');
  await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:900,deviceScaleFactor:1,mobile:true});
  await navigate(`/conversation/${encodeURIComponent(maya.sender)}/${maya.messageId}`,'Saturday at the market?');
  const button=(name:string)=>`Array.from(document.querySelectorAll('button')).find(b=>(b.getAttribute('aria-label')??b.textContent.trim())===${JSON.stringify(name)})`;
  await wait(async()=>evaluate(`Boolean(${button('Reply all')})`));
  await assertReadSettled();
  assert(await evaluate(`${button('Reply all')}.disabled===false`));
  await evaluate(`${button('Reply all')}.click()`);
  await wait(async()=>evaluate(`document.querySelector('form.reply-form')?.action.endsWith('?/replyAll')`));
  assert.equal(await evaluate(`document.querySelector('form.reply-form label').textContent.trim()`),'Reply to everyone');
  await evaluate(`${button('Cancel')}.click()`);
  assert(await evaluate(`!document.querySelector('[aria-label="Shared conversation"]')`));
  assert(await evaluate(`document.querySelector('.message-details').closest('.expanded-header')!==null`));
  for(const width of [320,390]){
    await cdp('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:true});
    assert(await evaluate(`(()=>{const tools=document.querySelector('.message-tools'),rect=tools.getBoundingClientRect();return getComputedStyle(tools).position==='fixed' && Math.abs((rect.left+rect.right)/2-innerWidth/2)<1 && rect.height===44;})()`),'Mobile message actions are centered in a compact floating bar at '+width);
    assert(await evaluate(`document.documentElement.scrollWidth<=innerWidth`));
    assert(await evaluate(`Math.abs(document.querySelector('.message-details').getBoundingClientRect().left-document.querySelector('.sender-identity').getBoundingClientRect().left)<1`),'Details aligns with the sender identity at '+width);
  }
  assert(await evaluate(`document.querySelector('.message-details').getBoundingClientRect().top>=document.querySelector('.sender-identity').getBoundingClientRect().bottom`),'Details remains below the identity');
  await evaluate(`document.querySelector('.message-details summary').click()`);
  assert(await evaluate(`document.querySelector('.message-details').textContent.includes('maya@connections.example.com')`));
  assert(await evaluate(`document.querySelectorAll('.message-details .detail-row > svg').length===2 && !document.querySelector('.message-details details')`),'Timestamp and participants have small icons with no nested disclosure');
  assert(await evaluate(`document.querySelector('.message-details ul').getBoundingClientRect().top>document.querySelector('.message-details time').getBoundingClientRect().top`),'Participants appear below the timestamp');
  assert(await evaluate(`document.documentElement.scrollWidth<=innerWidth`),'Expanded group details fit the viewport');

  assert(await evaluate(`${button('Reply all')}.querySelector('svg')!==null && ${button('Reply all')}.textContent.trim()===''`));
  await evaluate(`document.querySelector('[aria-label="More message actions"]').click()`);
  assert(await evaluate(`${button('Leave conversation')}.closest('details').open`));
  assert(await evaluate(`!${button('Revive expired participation')}`),'Active participation has no revival action');
  await evaluate(`${button('Leave conversation')}.click()`);
  await wait(async()=>evaluate(`Boolean(${button('Rejoin conversation')})`));
  assert(await evaluate(`${button('Reply all')}.disabled`));
  assert(await evaluate(`!${button('Revive expired participation')}`),'Left participation has no revival action');
  await evaluate(`document.querySelector('[aria-label="More message actions"]').click()`);
  await evaluate(`${button('Rejoin conversation')}.click()`);
  await wait(async()=>evaluate(`Boolean(${button('Leave conversation')})`));
  await fetch(origin+'/api/v1/account/fixture-expire',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  await navigate(`/conversation/${encodeURIComponent(maya.sender)}/${maya.messageId}`,'Saturday at the market?');
  await wait(async()=>evaluate(`document.body.textContent.includes('Your participation expired')`));
  assert(await evaluate(`!${button('Rejoin conversation')}`));
  assert(await evaluate(`!${button('Revive expired participation')}`),'Expired participation has no revival action');
  assert(await evaluate(`${button('Reply all')}.disabled`));
  // Reset synthetic state for the independent sent-message checks.
  await fetch(origin+'/api/v1/account/fixture-active',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  assert(await evaluate(`document.documentElement.scrollWidth<=innerWidth`));
  const own=(await accountOperation('HailMailbox/view',{view:'sent'})).messages[0];
  await navigate(`/conversation/${encodeURIComponent(own.sender)}/${own.messageId}`,'Saturday at the market?');
  await wait(async()=>evaluate(`Boolean(${button('Reply all')})`));
  await evaluate(`${button('Reply all')}.click()`);
  await wait(async()=>evaluate(`document.querySelector('form.reply-form')?.action.endsWith('?/replyAll')`));
  await navigate('/compose?audience=connections','Start a conversation.');
  await evaluate(`document.querySelector('#recipient-search').focus();document.querySelector('.recipient-option').click()`);
  await wait(async()=>evaluate(`document.querySelectorAll('.recipient-chip').length===1`));
  await evaluate(`document.querySelector('.recipient-option').click()`);
  await wait(async()=>evaluate(`document.querySelectorAll('.recipient-chip').length===2`));
  assert(await evaluate(`!document.querySelector('input[name="delivery"]')`));
  assert(await evaluate(`document.querySelector('.recipient-suggestions').hidden`));
  console.log('PASS: shared default, non-connection Reply all, leave/rejoin, expiry with readable history and mobile layout');
}
}finally{socket?.close();chrome.kill();fixture.kill();await Promise.all([chrome.exited,fixture.exited]);await rm(work,{recursive:true,force:true});}
