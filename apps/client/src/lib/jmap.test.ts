import {afterEach,describe,expect,it,vi} from 'vitest';
import {setMessageRead,removeReceivedMessage,restoreReceivedMessage} from './jmap.js';
const cap='https://haili.app/ns/jmap/messages',sender='did:plc:'+'a'.repeat(24),message='019a0000-0000-7000-8000-000000000001';
const session={primaryAccounts:{[cap]:'account'},accounts:{account:{isReadOnly:false,accountCapabilities:{[cap]:{mutableProperties:['isRead','isInTrash'],canDestroy:true}}}}};
const response=(name:string,value:unknown)=>({methodResponses:[[name,value,'read-state']]});
afterEach(()=>vi.unstubAllGlobals());
function transport(last= response('HailMessage/set',{accountId:'account',oldState:'state1',newState:'state2',updated:{record:null},notUpdated:null})){
  const queue=[session,response('HailMessage/query',{accountId:'account',ids:['record'],queryState:'state1'}),last];
  const fetch=vi.fn(async()=>Response.json(queue.shift()));vi.stubGlobal('fetch',fetch);return fetch;
}
describe('JMAP read-state workflow',()=>{
  it('resolves the received copy and writes with the observed state through the fixed provider bridge',async()=>{
    const fetch=transport();await setMessageRead(sender,message,true);
    expect(fetch.mock.calls.map(c=>(c as unknown[])[0])).toEqual(['/api/jmap/session','/api/jmap','/api/jmap']);
    const calls=fetch.mock.calls as unknown as [string,RequestInit][];
    expect(JSON.parse(calls[1]![1].body as string).methodCalls[0][1]).toEqual({accountId:'account',filter:{sender,messageId:message,inTrash:false},limit:2});
    expect(JSON.parse(calls[2]![1].body as string).methodCalls[0][1]).toEqual({accountId:'account',ifInState:'state1',update:{record:{isRead:true}}});
    expect(calls[2]![1]).toMatchObject({credentials:'same-origin',redirect:'error',cache:'no-store'});
  });
  it('reports a concurrent edit without retrying or falling back to the retired API',async()=>{
    const fetch=transport(response('error',{type:'stateMismatch'}));
    await expect(setMessageRead(sender,message,false)).rejects.toThrow('Refresh');expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('moves to Trash using the confirmed preference and restores through the same state precondition',async()=>{
    let fetch=transport();await removeReceivedMessage(sender,message,true);
    let calls=fetch.mock.calls as unknown as [string,RequestInit][];
    expect(JSON.parse(calls[2]![1].body as string).methodCalls[0][1]).toEqual({accountId:'account',ifInState:'state1',ifTrashEnabled:true,update:{record:{isInTrash:true}}});
    fetch=transport();await restoreReceivedMessage(sender,message);calls=fetch.mock.calls as unknown as [string,RequestInit][];
    expect(JSON.parse(calls[1]![1].body as string).methodCalls[0][1].filter.inTrash).toBe(true);
    expect(JSON.parse(calls[2]![1].body as string).methodCalls[0][1].update).toEqual({record:{isInTrash:false}});
  });
  it('permanently removes only when Trash was explicitly disabled',async()=>{
    const fetch=transport(response('HailMessage/set',{accountId:'account',oldState:'state1',newState:'state2',destroyed:['record'],notDestroyed:null}));
    await removeReceivedMessage(sender,message,false);const calls=fetch.mock.calls as unknown as [string,RequestInit][];
    expect(JSON.parse(calls[2]![1].body as string).methodCalls[0][1]).toEqual({accountId:'account',ifInState:'state1',ifTrashEnabled:false,destroy:['record']});
  });
  it('rejects missing write capability before querying',async()=>{
    const fetch=vi.fn(async()=>Response.json({...session,accounts:{account:{isReadOnly:true}}}));vi.stubGlobal('fetch',fetch);
    await expect(setMessageRead(sender,message,true)).rejects.toThrow();expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects method-level success with an item failure',async()=>{
    transport(response('HailMessage/set',{accountId:'account',oldState:'state1',newState:'state1',updated:null,notUpdated:{record:{type:'forbidden'}}}));
    await expect(setMessageRead(sender,message,true)).rejects.toThrow();
  });
});
