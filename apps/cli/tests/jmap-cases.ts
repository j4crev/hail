import assert from 'node:assert/strict';
export async function jmapCases(binary:string,provider:string,env:Record<string,string|undefined>,install:(handler:(r:Request)=>Promise<Response>)=>void){
 const did='did:plc:'+'a'.repeat(24),message='019a0000-0000-7000-8000-000000000001',account='opaque-account',id='m_opaque-message',cap='https://racrproto.com/ns/jmap/messages';
 const json=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
 let mode='',calls:string[]=[],cases=0;
 install(async request=>{
  assert.equal(request.headers.get('authorization'),'Bearer racr_'+'a'.repeat(43));
  const path=new URL(request.url).pathname;calls.push(path);
  if(path==='/.well-known/jmap')return json({apiUrl:'https://foreign.example/jmap',primaryAccounts:{[cap]:account},accounts:{[account]:{accountCapabilities:{[cap]:{canDestroy:mode!=='forbidden'}}}}});
  assert.equal(path,'/jmap');const input=await request.json(),[method,args,tag]=input.methodCalls[0];
  assert.deepEqual(input.using,['urn:ietf:params:jmap:core',cap]);assert.equal(args.accountId,account);
  if(method==='HailMessage/query'){
   assert.deepEqual(args.filter,{sender:did,messageId:message});
   return json({methodResponses:[[method,{accountId:account,queryState:'state-1',ids:mode==='absent'?[]:[id]},tag]]});
  }
  assert.equal(method,'HailMessage/set');assert.deepEqual(args,{accountId:account,ifInState:'state-1',destroy:[id]});
  if(mode==='stale')return json({methodResponses:[['error',{type:'stateMismatch'},tag]]});
  if(mode==='lost')return new Response(null,{status:503});
  return json({methodResponses:[[method,{accountId:account,destroyed:mode==='item-error'?null:[id],notDestroyed:mode==='item-error'?{[id]:{type:'forbidden'}}:null},tag]]});
 });
 for(const command of ['inbox','message'])for(mode of ['','absent','forbidden','stale','item-error','lost']){
  calls=[];const child=Bun.spawn([binary,command,'delete',did,message],{env,stdout:'pipe',stderr:'pipe'});
  const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  assert.equal(code===0,['','absent'].includes(mode),err);assert(!(out+err).includes('racr_'+'a'.repeat(43)));
  if(code===0)assert.equal(JSON.parse(out).state,'deleted');
  assert.equal(calls.length,mode==='forbidden'?1:mode==='absent'?2:3);cases++;
 }
 console.log(`JMAP deletion workflows: ${cases} cases passed`);
 let changes=0, baseline=0, gets=0, states:string[]=[], child:ReturnType<typeof Bun.spawn>|undefined;
 let signal: "SIGINT"|"SIGTERM"|undefined;
 install(async request=>{
  assert.equal(new URL(request.url).origin,provider);
  assert.equal(request.headers.get('authorization'),'Bearer racr_'+'a'.repeat(43));
  const path=new URL(request.url).pathname;calls.push(path);
  if(path==='/.well-known/jmap'){if(mode==='session-hang')return new Promise<Response>(()=>{});return json({apiUrl:'https://foreign.example/jmap',primaryAccounts:{[cap]:account},accounts:{[account]:{accountCapabilities:{[cap]:{}}}}});}
  assert.equal(path,'/jmap');assert.equal(request.method,'POST');
  const input=await request.json();assert.equal(input.methodCalls.length,1);
  const [method,args,tag]=input.methodCalls[0];
  assert.deepEqual(input.using,['urn:ietf:params:jmap:core',cap]);assert.equal(args.accountId,account);
  const result=(value:unknown)=>json({methodResponses:[[method,{accountId:account,...value as object},tag]]});
  if(method==='HailMessage/get'){
   if(args.ids.length===0){baseline++;assert.deepEqual(args,{accountId:account,ids:[]});return result({state:'baseline',list:[],notFound:[]});}
   gets++;assert.deepEqual(args,{accountId:account,ids:[id],properties:['id','sender','messageId','deliveredAt']});
   if(mode==='get-retry'&&gets===1)return new Response(null,{status:503,headers:{'Retry-After':'1'}});
   return result({state:'later-get-state',list:mode==='missing'?[]:[{id:mode==='foreign-id'?'foreign':id,sender:mode==='filtered'&&changes===1?'did:plc:'+'b'.repeat(24):did,messageId:message,deliveredAt:'2026-11-10T00:00:00Z'}],notFound:mode==='missing'?[id]:[]});
  }
  assert.equal(method,'HailMessage/changes');changes++;states.push(args.sinceState);
  assert.deepEqual(Object.keys(args).sort(),['accountId','maxChanges','sinceState']);assert.equal(args.maxChanges,50);
  if(signal)setTimeout(()=>child?.kill(signal!),100);
  if(mode==='hang')return new Promise<Response>(()=>{});
  if(mode==='expired'||mode==='account-reset')return json({methodResponses:[['error',{type:mode==='expired'?'cannotCalculateChanges':'accountNotFound'},tag]]});
  if(mode==='throttle')return new Response(null,{status:429,headers:{'Retry-After':'600'}});
  if(mode==='retry'&&changes===1)return new Response(null,{status:503,headers:{'Retry-After':'1'}});
  const empty=mode==='empty'||mode==='missing'&&changes>1;
  const advance=mode==='updates'&&changes===1;
  return result({oldState:mode==='wrong-old-state'?'foreign-state':args.sinceState,newState:empty?args.sinceState:'state-'+changes,hasMoreChanges:advance||mode==='filtered'&&changes===1||mode==='more',created:empty||advance?[]:[id],updated:advance?['updated']:[],destroyed:advance?['destroyed']:[]});
 });
 const wait=async(selected:string,options:string[]=[],expected?:string)=>{
  mode=selected;calls=[];changes=0;baseline=0;gets=0;states=[];
  const started=performance.now();
  child=Bun.spawn([binary,'--json','inbox','wait',...(options.includes('--timeout')?[]:['--timeout','2']),'--interval','1',...options],{env,stdout:'pipe',stderr:'pipe'});
  const watchdog=setTimeout(()=>child?.kill('SIGKILL'),6000);
  let code:number,out:string,err:string;
  try{[code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);}finally{clearTimeout(watchdog);}
  assert.ok(performance.now()-started<5000,'wait exceeded bounded timeout');
  assert.equal(code,expected?1:0,err);assert(!(out+err).includes('racr_'+'a'.repeat(43)));
  cases++;
  if(expected){assert.equal(JSON.parse(err).error.code,expected);return null;}
  const result=JSON.parse(out);assert.equal(result.contentTrust,'untrusted');
  assert.deepEqual(Object.keys(result).sort(),['cliContractVersion','contentTrust','cursor','hasMore','messages','wait']);
  return result;
 };
 let result=await wait('normal');assert.equal(baseline,1);assert.deepEqual(states,['baseline']);assert.equal(result.cursor,'state-1');assert.equal(result.messages[0].messageId,message);assert.deepEqual(result.wait,{completed:true,timedOut:false,interrupted:false});
 result=await wait('normal',['--after','opaque &+/ state']);assert.equal(baseline,0);assert.deepEqual(states,['opaque &+/ state']);assert.equal(result.cursor,'state-1');
 for(const selected of ['updates','filtered']){
  const started=performance.now();result=await wait(selected,['--after','saved','--from',did]);assert.ok(performance.now()-started<1000,'hasMoreChanges must drain without polling sleep');assert.equal(changes,2);assert.deepEqual(states,['saved','state-1']);assert.equal(gets,selected==='updates'?1:2);assert.equal(result.cursor,'state-2');assert.equal(result.messages.length,1);
 }
 result=await wait('more',['--after','saved']);assert.equal(result.hasMore,true);assert.equal(changes,1);
 for(const selected of ['expired','account-reset'])await wait(selected,['--after','saved'],'JMAP_RESYNC_REQUIRED');
 for(const selected of ['foreign-id','wrong-old-state'])await wait(selected,['--after','saved'],'RESPONSE_ERROR');
 for(const selected of ['empty','missing','hang','throttle']){
  result=await wait(selected,['--after','saved','--timeout','1']);assert.deepEqual(result.messages,[]);assert.equal(result.cursor,selected==='missing'?'state-1':'saved');assert.equal(result.hasMore,false);assert.deepEqual(result.wait,{completed:false,timedOut:true,interrupted:false});
 }
 result=await wait('empty',['--timeout','1']);assert.equal(result.cursor,'baseline');assert.equal(baseline,1);
 result=await wait('session-hang',['--timeout','1']);assert.equal(result.cursor,null);assert.equal(changes,0);
 for(const options of [['--timeout','0'],['--from','bad'],['--after',''],['--after','bad\nstate']]){await wait('normal',options,'USAGE_ERROR');assert.equal(calls.length,0);}
 for(const selected of ['retry','get-retry']){
  const started=performance.now();result=await wait(selected,['--after','saved','--timeout','4']);assert.ok(performance.now()-started>=1000);assert.deepEqual(states,['saved','saved']);assert.equal(result.messages.length,1);
 }
 for(signal of ['SIGINT','SIGTERM'] as const)for(const selected of ['empty','hang']){
  result=await wait(selected,['--after','saved']);assert.deepEqual(result.messages,[]);assert.equal(result.cursor,'saved');assert.deepEqual(result.wait,{completed:false,timedOut:false,interrupted:true});
 }
 signal=undefined;
 console.log(`JMAP deletion and inbox change-state workflows: ${cases} cases passed`);
}
