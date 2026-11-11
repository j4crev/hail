import {describe,expect,it,vi} from 'vitest';
import {HAIL_PUSH,type JmapPush} from '../src/jmap/push.js';
import {Hono} from 'hono';
import type {AccountApiRepository,AccountApiSession} from '../src/accounts/repository.js';
import type {JmapMessages} from '../src/jmap/messages.js';
import {registerJmapRoutes} from '../src/jmap/routes.js';
import vectors from '../../../spec/vectors/jmap.json';
const origin='https://provider.example.com';
const session={account_id:'fixture',did:'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',canonical_address:'test@example.com',scopes:['messages:read']} as AccountApiSession;
function app(){
  const app=new Hono();
  const accounts={authenticate:async(auth?:string,cookie?:string)=>auth==='Bearer valid'||cookie==='valid'?session:null} as AccountApiRepository;
  const messages={accountId:()=> 'account_fixture'} as unknown as JmapMessages;
  registerJmapRoutes(app,accounts,messages,origin);return app;
}
describe('JMAP request conformance vectors',()=>{
  for(const vector of vectors.cases)it(vector.name,async()=>{
    const result=await app().request(origin+'/jmap',{method:'POST',headers:{Authorization:'Bearer valid','Content-Type':'application/json'},body:JSON.stringify(vector.request)});
    expect(result.status).toBe(vector.status);const body=await result.json();
    if(vector.responses)expect(body.methodResponses).toEqual(vector.responses);
    else expect(body.type).toBe(vector.problem);
    if("createdIds" in vector)expect(body.createdIds).toEqual(vector.createdIds);
  });
  it('advertises protocol-domain capabilities and rejects the retired provider namespace',async()=>{
    const server=app(),headers={Authorization:'Bearer valid','Content-Type':'application/json'};
    const document=await (await server.request(origin+'/.well-known/jmap',{headers})).json();
    expect(document.capabilities['https://racrproto.com/ns/jmap/messages']).toBeDefined();
    expect(document.primaryAccounts['https://racrproto.com/ns/jmap/messages']).toBe('account_fixture');
    expect(JSON.stringify(document)).not.toContain('https://haili.app/ns/jmap/');
    const old=await server.request(origin+'/jmap',{method:'POST',headers,body:JSON.stringify({using:['urn:ietf:params:jmap:core','https://haili.app/ns/jmap/messages'],methodCalls:[]})});
    expect(old.status).toBe(400);
    expect((await old.json()).type).toBe('urn:ietf:params:jmap:error:unknownCapability');
  });
  it('rejects duplicate keys and cookies without exact browser Origin',async()=>{
    const server=app();const headers={'Content-Type':'application/json',Cookie:'hail_session=valid'};
    const body='{"using":["urn:ietf:params:jmap:core"],"methodCalls":[]}';
    expect((await server.request(origin+'/jmap',{method:'POST',headers,body})).status).toBe(403);
    expect((await server.request(origin+'/jmap',{method:'POST',headers:{...headers,Origin:origin},body})).status).toBe(200);
    const duplicate=await server.request(origin+'/jmap',{method:'POST',headers:{...headers,Origin:origin},body:'{"using":[],"using":[],"methodCalls":[]}'});
    expect(duplicate.status).toBe(400);expect((await duplicate.json()).type).toBe('urn:ietf:params:jmap:error:notJSON');
  });
  it('reserves mutation endpoints and validates event parameters without advertising writable accounts',async()=>{
    const server=app(),headers={Authorization:'Bearer valid'};
    const session=await (await server.request(origin+'/.well-known/jmap',{headers})).json();
    expect(session.accounts.account_fixture.isReadOnly).toBe(true);
    expect((await server.request(origin+'/jmap/upload/account_fixture',{method:'POST',headers})).status).toBe(403);
    expect((await server.request(origin+'/jmap/events',{headers})).status).toBe(400);
  });
});


describe('JMAP push transport boundary',()=>{
  const core='urn:ietf:params:jmap:core',id='11111111-1111-4111-8111-111111111111';
  function fixture(){
    const server=new Hono(),authenticate=vi.fn(async(auth?:string,cookie?:string,_touch?:boolean)=>auth==='Bearer valid'||cookie==='valid'?session:null);
    const get=vi.fn(async(_session:AccountApiSession,args:Record<string,unknown>)=>({list:[{id}],notFound:[],received:args}));
    const set=vi.fn(async(_session:AccountApiSession,args:Record<string,unknown>)=>args.create?{created:{device:{id}}}:{destroyed:args.destroy,updated:args.update});
    const capability={applicationServerKey:'public-key',contentEncoding:'aes128gcm',maxSubscriptions:4};
    registerJmapRoutes(server,{authenticate} as unknown as AccountApiRepository,{accountId:()=> 'account_fixture'} as unknown as JmapMessages,
      origin,origin,undefined,undefined,undefined,undefined,{capability:()=>capability,get,set} as unknown as JmapPush);
    return {server,authenticate,get,set,capability};
  }
  it('advertises push only when configured and rejects disabled methods/capability',async()=>{
    const server=app(),headers={Authorization:'Bearer valid','Content-Type':'application/json'};
    const document=await (await server.request(origin+'/.well-known/jmap',{headers})).json();
    expect(document.capabilities[HAIL_PUSH]).toBeUndefined();
    const disabled=await server.request(origin+'/jmap',{method:'POST',headers,body:JSON.stringify({using:[core],methodCalls:[['PushSubscription/get',{},'get']]})});
    expect((await disabled.json()).methodResponses).toEqual([['error',{type:'unknownMethod'},'get']]);
    const unknown=await server.request(origin+'/jmap',{method:'POST',headers,body:JSON.stringify({using:[core,HAIL_PUSH],methodCalls:[]})});
    expect(unknown.status).toBe(400);
    const enabled=fixture();
    const current=await (await enabled.server.request(origin+'/.well-known/jmap',{headers})).json();
    expect(current.capabilities[HAIL_PUSH]).toEqual(enabled.capability);
  });
  it('dispatches core-only methods without accountId and resolves creation and result references',async()=>{
    const f=fixture();
    const response=await f.server.request(origin+'/jmap',{method:'POST',headers:{Authorization:'Bearer valid','Content-Type':'application/json'},body:JSON.stringify({
      using:[core],createdIds:{},methodCalls:[
        ['PushSubscription/set',{create:{device:{deviceClientId:'browser'}}},'create'],
        ['PushSubscription/get',{ids:['#device']},'get'],
        ['PushSubscription/set',{'#destroy':{resultOf:'get',name:'PushSubscription/get',path:'/list/*/id'},update:{'#device':{types:[]}}},'remove']
      ]})});
    expect(response.status).toBe(200);const body=await response.json();
    expect(body.methodResponses.map((call:unknown[])=>call[0])).toEqual(['PushSubscription/set','PushSubscription/get','PushSubscription/set']);
    expect(body.createdIds).toEqual({device:id});
    expect(f.get).toHaveBeenCalledWith(session,{ids:[id]});
    expect(f.set).toHaveBeenLastCalledWith(session,{destroy:[id],update:{[id]:{types:[]}}});
  });
  it('does not let background requests bypass authentication or Origin checks or refresh idle time',async()=>{
    const f=fixture(),body=JSON.stringify({using:[core],methodCalls:[['PushSubscription/get',{},'get']]});
    const headers={'Content-Type':'application/json','X-Hail-Background':'true'};
    expect((await f.server.request(origin+'/jmap',{method:'POST',headers,body})).status).toBe(401);
    expect((await f.server.request(origin+'/jmap',{method:'POST',headers:{...headers,Cookie:'hail_session=valid'},body})).status).toBe(403);
    expect((await f.server.request(origin+'/jmap',{method:'POST',headers:{...headers,Cookie:'hail_session=valid',Origin:'https://evil.example.com'},body})).status).toBe(403);
    expect(f.get).not.toHaveBeenCalled();
    expect((await f.server.request(origin+'/jmap',{method:'POST',headers:{...headers,Cookie:'hail_session=valid',Origin:origin},body})).status).toBe(200);
    expect(f.authenticate).toHaveBeenLastCalledWith(undefined,'valid',false);
    expect((await f.server.request(origin+'/.well-known/jmap',{headers:{Cookie:'hail_session=valid','X-Hail-Background':'true'}})).status).toBe(200);
    expect(f.authenticate).toHaveBeenLastCalledWith(undefined,'valid',false);
    await f.server.request(origin+'/.well-known/jmap',{headers:{Cookie:'hail_session=valid'}});
    expect(f.authenticate).toHaveBeenLastCalledWith(undefined,'valid',true);
  });
});
