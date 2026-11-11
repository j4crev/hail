import {JmapMessages} from '../src/jmap/messages.js';
import {expect,it,vi} from 'vitest';
import {createApp} from '../src/app.js';
import type {AppConfig} from '../src/config.js';
import type {AccountApiRepository} from '../src/accounts/repository.js';
import type {AccountMessaging} from '../src/accounts/messaging.js';
import type {GrantRepository} from '../src/grants/repository.js';
import type {GrantService} from '../src/grants/service.js';
it('requires authenticated scoped same-origin web access for Trash mutations',async()=>{
  const session={account_id:crypto.randomUUID(),did:'did:plc:'+'a'.repeat(24),credential_id:crypto.randomUUID(),serving_generation:1,
    passkey_credential_id:'passkey' as string|null,scopes:['messages:read','messages:write'],migration_state:null};
  let authenticated=true;
  const accounts={authenticate:vi.fn(async()=>authenticated?session:null)} as unknown as AccountApiRepository;
  const remove=vi.fn(async()=>({state:'trashed'})),saveSettings=vi.fn(async()=>({trashEnabled:false}));
  const saveDisplaySettings=vi.fn(async()=>({theme:'dark',showHeaderImages:true}));
  const empty=vi.fn(async()=>({deleted:1})),clearSent=vi.fn(async()=>({affected:1,state:"trashed"})),restoreSent=vi.fn(async()=>({restored:1}));
  const messaging={trash:{empty,clearSent,restoreSent,remove,saveSettings,saveDisplaySettings,settings:async()=>({trashEnabled:true})},inboxFeed:async()=>({messages:[],next:null})} as unknown as AccountMessaging;
  const origin='https://example.com',app=createApp({publicOrigin:origin,providerId:'test',passkeys:{origin}} as AppConfig,
    {jmap:new JmapMessages({} as never,origin),accountApi:{accounts,grants:{} as GrantRepository,service:{} as GrantService,messaging},async checkReadiness(){return {ready:true};}});
  const path='/api/v1/account/inbox/did:plc:'+ 'b'.repeat(24)+'/019a0000-0000-7000-8000-000000000001/permanent-delete';
  const headers={Cookie:'hail_session=fixture',Origin:origin,'Content-Type':'application/json'};
  const post=async(name:string,args:unknown={},extra={})=>{
    const response=await app.request('/jmap',{method:'POST',headers:{...headers,...extra},body:JSON.stringify({using:['urn:ietf:params:jmap:core','https://haili.app/ns/jmap/account'],methodCalls:[[name,{accountId:new JmapMessages({} as never,origin).accountId(session as never),...(args as object)},'test']]})});
    if(!response.ok)return response;const data=await response.json() as any;const [method,result]=data.methodResponses[0];
    return Response.json(result,{status:method==='error'?(result.httpStatus??(result.type==='forbidden'?403:400)):200});
  };
  expect((await post('HailMailbox/preferences',{input:{trashEnabled:false}})).status).toBe(200);
  expect(saveSettings).toHaveBeenCalledWith(session,false);
  expect((await post('HailMailbox/preferences',{input:{theme:'dark'}})).status).toBe(200);
  expect(saveDisplaySettings).toHaveBeenCalledWith(session,{theme:'dark'});
  expect((await post('HailMailbox/preferences',{input:{theme:'dark',trashEnabled:false}})).status).toBe(400);
  expect(saveSettings).toHaveBeenCalledTimes(1);
  expect((await post('HailMailbox/view',{view:'inboxFeed',trash:true,unknown:1})).status).toBe(400);
  for(const [url,body] of [['HailMailbox/emptyTrash',{}],['HailMailbox/clearSent',{input:{trashEnabled:true}}],['HailMailbox/restoreSent',{input:{kind:'message',messageId:'019a0000-0000-7000-8000-000000000001'}}]] as const){
    authenticated=false;expect((await post(url,body)).status).toBe(401);authenticated=true;
    expect((await post(url,body,{Origin:'https://evil.example'})).status).toBe(403);
    session.scopes=['messages:read'];expect((await post(url,body)).status).toBe(403);
    session.scopes=['messages:read','messages:write'];session.passkey_credential_id=null;
    expect((await post(url,body)).status).toBe(403);session.passkey_credential_id='passkey';
    expect((await post(url,{...body,extra:true})).status).toBe(400);
    expect((await post(url,body)).status).toBe(200);
  }
  expect(empty).toHaveBeenCalledTimes(1);expect(clearSent).toHaveBeenCalledWith(session,true,undefined);
  const selected=[{kind:'message',messageId:'019a0000-0000-7000-8000-000000000001'}];
  expect((await post('HailMailbox/clearSent',{input:{trashEnabled:true,messages:selected}})).status).toBe(200);
  expect(clearSent).toHaveBeenLastCalledWith(session,true,selected);
  expect((await app.request(path,{method:"POST",headers})).status).toBe(404);
  expect(remove).not.toHaveBeenCalled();
});
