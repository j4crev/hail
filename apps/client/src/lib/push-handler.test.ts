import {expect,it,vi} from 'vitest';
import {handlePush} from './push-handler.js';

const id='12345678-1234-1234-1234-123456789abc';
const verification={'@type':'PushVerification',pushSubscriptionId:id,verificationCode:'A'.repeat(43)};
const state={'@type':'StateChange',changed:{current:{HailMessage:'opaque'}}};
const session={accounts:{current:{}},primaryAccounts:{'https://haili.app/ns/jmap/messages':'current'},apiUrl:'https://attacker.example/jmap'};
const accepted={methodResponses:[['PushSubscription/set',{updated:{[id]:null},notUpdated:null},'verify-push']]};
const setup=(response:unknown=session,status=200)=>({request:vi.fn<typeof fetch>(async()=>Response.json(response,{status})),notify:vi.fn(async()=>{})});

it('verifies only through the authenticated same-origin bridge and confirms success generically',async()=>{
  const deps=setup(accepted);await handlePush(verification,deps);
  expect(deps.request).toHaveBeenCalledTimes(1);
  const [url,options]=deps.request.mock.calls[0]!;
  expect(url).toBe('/api/jmap');
  expect(options).toMatchObject({method:'POST',credentials:'same-origin',cache:'no-store',redirect:'error',headers:{'Content-Type':'application/json','X-Hail-Background':'true'}});
  expect(JSON.parse(options!.body as string)).toEqual({using:['urn:ietf:params:jmap:core'],methodCalls:[['PushSubscription/set',{update:{[id]:{verificationCode:verification.verificationCode}}},'verify-push']]});
  expect(deps.notify).toHaveBeenCalledExactlyOnceWith('Hail',{body:'Notifications enabled.',tag:'hail-updates'});
});

it('does not confirm verification rejected by the current credential or an invalid response',async()=>{
  for(const response of [
    {methodResponses:[['error',{type:'forbidden'},'verify-push']]},
    {methodResponses:[['PushSubscription/set',{updated:{},notUpdated:{[id]:{type:'notFound'}}},'verify-push']]},
    {methodResponses:[['PushSubscription/set',{updated:{[id]:null},notUpdated:{[id]:{type:'notFound'}}},'verify-push']]},
    {methodResponses:[['PushSubscription/set',{updated:{[id]:null}},'wrong']]},{}
  ]){const deps=setup(response);await handlePush(verification,deps);expect(deps.notify).not.toHaveBeenCalled();}
  const deps=setup({},401);await handlePush(verification,deps);expect(deps.notify).not.toHaveBeenCalled();
});

it('shows generic hints only for the current authenticated account without fetching or changing mail',async()=>{
  const deps=setup();await handlePush(state,deps);
  expect(deps.request).toHaveBeenCalledExactlyOnceWith('/api/jmap/session',expect.objectContaining({method:'GET',credentials:'same-origin',cache:'no-store',redirect:'error',headers:{'X-Hail-Background':'true'}}));
  expect(deps.notify).toHaveBeenCalledExactlyOnceWith('Hail',{body:'Your mailbox has updates.',tag:'hail-updates'});
  for(const response of [
    {accounts:{other:{}},primaryAccounts:{messages:'other'}},
    {accounts:{current:{}},primaryAccounts:{messages:'other'}},
    {accounts:{},primaryAccounts:{messages:'current'}},{}
  ]){const stale=setup(response);await handlePush(state,stale);expect(stale.notify).not.toHaveBeenCalled();}
});

it('ignores malformed, oversized, foreign-type and URL-bearing payloads before any request',async()=>{
  for(const payload of [null,[],{}, {...verification,verificationCode:'short'}, {...verification,pushSubscriptionId:'https://attacker.example'},
    {...verification,url:'https://attacker.example'}, {...state,url:'https://attacker.example'},
    {'@type':'StateChange',changed:{}}, {'@type':'StateChange',changed:{current:{HailMessage:'x'},other:{HailMessage:'y'}}},
    {'@type':'StateChange',changed:{current:{HailMessage:'x'.repeat(1025)}}},
    {'@type':'StateChange',changed:{current:{HailMessage:''}}},
    {'@type':'StateChange',changed:{current:{HailConversation:'opaque'}}},
    {'@type':'StateChange',changed:{current:{HailMessage:{url:'https://attacker.example'}}}}
  ]){const deps=setup();await handlePush(payload,deps);expect(deps.request).not.toHaveBeenCalled();expect(deps.notify).not.toHaveBeenCalled();}
});

it('suppresses expired sessions, oversized responses and transport/notification failures',async()=>{
  const loggedOut=setup({},401);await handlePush(state,loggedOut);expect(loggedOut.notify).not.toHaveBeenCalled();
  const oversized=setup({...session,padding:'x'.repeat(65537)});await handlePush(state,oversized);expect(oversized.notify).not.toHaveBeenCalled();
  const offline=setup();offline.request.mockRejectedValue(new Error('offline'));await handlePush(state,offline);expect(offline.notify).not.toHaveBeenCalled();
  const denied=setup();denied.notify.mockRejectedValue(new Error('denied'));await expect(handlePush(state,denied)).resolves.toBeUndefined();
});
