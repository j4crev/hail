import {beforeEach,expect,it,vi} from 'vitest';
const clear=vi.hoisted(()=>vi.fn());
vi.mock('./mailbox-cache.js',()=>({mailboxCache:{clear}}));
import {MailboxSync} from './jmap-sync.js';
const CORE='urn:ietf:params:jmap:core',MESSAGE='https://haili.app/ns/jmap/messages',DRAFT='https://haili.app/ns/jmap/drafts',ACCOUNT='https://haili.app/ns/jmap/account';
const types=['HailMessage','HailDraft','HailSent','HailSubmission','HailGrant','HailRelationship'];
type Event={operation:'created'|'updated'|'destroyed';id:string};
function provider(){
  let accountId='account_generation_1',sessionState='session_1';
  const events=new Map(types.map(type=>[type,[] as Event[]])),floor=new Map<string,number>();
  const fail=new Map<string,'http'|'method'|'state'>();
  const state=(type:string,revision:number)=>`${accountId}_${type}_${revision}`;
  function transport(){
    const calls:Array<{method:string;args:Record<string,any>}>=[];
    const fetcher=vi.fn(async(path:RequestInfo|URL,init?:RequestInit)=>{
      expect(init).toMatchObject({credentials:'same-origin',cache:'no-store',redirect:'error'});
      if(path==='/api/jmap/session'){
        expect(init?.method).toBe('GET');
        return Response.json({username:'alice',state:sessionState,apiUrl:'https://foreign.example/jmap',primaryAccounts:{[MESSAGE]:accountId,[DRAFT]:accountId,[ACCOUNT]:accountId},
          accounts:{[accountId]:{accountCapabilities:{[MESSAGE]:{},[DRAFT]:{},[ACCOUNT]:{types:types.slice(2)}}}}});
      }
      expect(path).toBe('/api/jmap');expect(init?.method).toBe('POST');
      const body=JSON.parse(String(init?.body));expect(body.methodCalls).toHaveLength(1);
      const [method,args,tag]=body.methodCalls[0],type=method.split('/')[0];
      expect(tag).toBe('sync');expect(args.accountId).toBe(accountId);
      expect(body.using).toEqual([CORE,type==='HailMessage'?MESSAGE:type==='HailDraft'?DRAFT:ACCOUNT]);calls.push({method,args});
      const failure=fail.get(type);fail.delete(type);
      if(failure==='http')return new Response(null,{status:503});
      if(failure==='method')return Response.json({methodResponses:[['error',{type:'serverFail'},tag]]});
      const rows=events.get(type)!;
      if(method.endsWith('/get')){expect(args.ids).toEqual([]);return Response.json({methodResponses:[[method,{accountId,state:state(type,rows.length),list:[],notFound:[]},tag]]});}
      expect(method).toBe(type+'/changes');expect(args.maxChanges).toBe(50);
      const since=Number(String(args.sinceState).split('_').at(-1));expect(args.sinceState).toBe(state(type,since));
      if(since<(floor.get(type)??0))return Response.json({methodResponses:[['error',{type:'cannotCalculateChanges'},tag]]});
      const end=Math.min(since+50,rows.length),page=rows.slice(since,end);
      return Response.json({methodResponses:[[method,{accountId,oldState:failure==='state'?'foreign-state':args.sinceState,newState:state(type,end),
        created:page.filter(e=>e.operation==='created').map(e=>e.id),updated:page.filter(e=>e.operation==='updated').map(e=>e.id),
        destroyed:page.filter(e=>e.operation==='destroyed').map(e=>e.id),hasMoreChanges:end<rows.length},tag]]});
    });
    return {calls,fetcher,sync:new MailboxSync(fetcher as typeof fetch)};
  }
  return {transport,fail,floor,events,reset(){accountId='account_generation_2';sessionState='session_2';for(const rows of events.values())rows.length=0;floor.clear();}};
}
beforeEach(()=>clear.mockClear());
it('lets two independent clients discover all collections and converge after missed creates, edits and deletions',async()=>{
  const server=provider(),a=server.transport(),b=server.transport();
  expect(await a.sync.poll()).toBe(true);expect(await b.sync.poll()).toBe(true);
  expect(a.calls.map(c=>c.method)).toEqual(types.map(type=>type+'/get'));
  expect(await a.sync.poll()).toBe(false);expect(await b.sync.poll()).toBe(false);
  server.events.get('HailMessage')!.push({id:'m_one',operation:'created'});expect(await a.sync.poll()).toBe(true);
  server.events.get('HailMessage')!.push({id:'m_one',operation:'updated'},{id:'m_two',operation:'destroyed'});
  server.events.get('HailDraft')!.push({id:'d_saved',operation:'updated'});server.events.get('HailSent')!.push({id:'o_send',operation:'created'});
  server.events.get('HailGrant')!.push({id:'o_grant',operation:'updated'});
  expect(await b.sync.poll()).toBe(true);expect(await a.sync.poll()).toBe(true);
  expect(b.calls.filter(c=>c.method==='HailMessage/changes').at(-1)!.args.sinceState).toBe('account_generation_1_HailMessage_0');
  expect(a.calls.filter(c=>c.method==='HailMessage/changes').at(-1)!.args.sinceState).toBe('account_generation_1_HailMessage_1');
  expect(await a.sync.poll()).toBe(false);expect(await b.sync.poll()).toBe(false);expect(clear).toHaveBeenCalledTimes(5);
});
it('retains paged cursors so later polls observe the remaining changes',async()=>{
  const server=provider(),client=server.transport();await client.sync.poll();
  for(let i=0;i<60;i++)server.events.get('HailSubmission')!.push({id:'o_'+i,operation:'updated'});
  expect(await client.sync.poll()).toBe(true);expect(await client.sync.poll()).toBe(true);expect(await client.sync.poll()).toBe(false);
  expect(client.calls.filter(c=>c.method==='HailSubmission/changes').map(c=>c.args.sinceState)).toEqual([
    'account_generation_1_HailSubmission_0','account_generation_1_HailSubmission_50','account_generation_1_HailSubmission_60']);
});
it('invalidates expired cursors and obtains fresh state without sending mailbox mutations',async()=>{
  const server=provider(),client=server.transport();await client.sync.poll();
  server.events.get('HailRelationship')!.push({id:'o_removed',operation:'destroyed'});server.floor.set('HailRelationship',1);
  expect(await client.sync.poll()).toBe(true);expect(await client.sync.poll()).toBe(false);
  expect(client.calls.filter(c=>c.method.startsWith('HailRelationship/')).map(c=>c.method)).toEqual(['HailRelationship/get','HailRelationship/changes','HailRelationship/get']);
  expect(await client.sync.poll()).toBe(false);expect(clear).toHaveBeenCalledTimes(2);
  expect(client.calls.every(c=>c.method.endsWith('/get')||c.method.endsWith('/changes'))).toBe(true);
});
it('resets every cursor when the provider account generation changes',async()=>{
  const server=provider(),client=server.transport();await client.sync.poll();server.reset();expect(await client.sync.poll()).toBe(true);
  expect(client.calls.slice(-types.length).map(c=>[c.method,c.args.accountId])).toEqual(types.map(type=>[type+'/get','account_generation_2']));
  expect(await client.sync.poll()).toBe(false);expect(clear).toHaveBeenCalledTimes(2);
});
it.each(['http','method','state'] as const)('does not consume earlier collection changes when a later collection has a %s failure',async failure=>{
  const server=provider(),client=server.transport();await client.sync.poll();
  server.events.get('HailMessage')!.push({id:'m_new',operation:'created'});server.fail.set('HailSent',failure);
  await expect(client.sync.poll()).rejects.toThrow();expect(clear).toHaveBeenCalledTimes(1);
  expect(await client.sync.poll()).toBe(true);expect(clear).toHaveBeenCalledTimes(2);
  expect(client.calls.filter(c=>c.method==='HailMessage/changes').map(c=>c.args.sinceState)).toEqual(['account_generation_1_HailMessage_0','account_generation_1_HailMessage_0']);
  expect(await client.sync.poll()).toBe(false);
});
it('does not commit a newly discovered identity when its first synchronization fails',async()=>{
  const server=provider(),client=server.transport();server.fail.set('HailSent','http');
  await expect(client.sync.poll()).rejects.toThrow();expect(clear).not.toHaveBeenCalled();
  expect(await client.sync.poll()).toBe(true);expect(clear).toHaveBeenCalledTimes(1);
  expect(client.calls.filter(c=>c.method==='HailMessage/get')).toHaveLength(2);
});
