import {expect,it} from 'vitest';
import {Hono} from 'hono';
import {registerJmapRoutes} from '../src/jmap/routes.js';
import type {JmapMessages} from '../src/jmap/messages.js';
import type {JmapDrafts} from '../src/jmap/drafts.js';
import type {AccountApiRepository,AccountApiSession} from '../src/accounts/repository.js';
import vectors from '../../../spec/vectors/jmap-drafts.json';
for(const vector of vectors.cases)it(vector.name,async()=>{
  const accountId='account_fixture',state='draft_state';
  const session={account_id:'fixture',canonical_address:'test@example.com',scopes:['messages:read'],passkey_credential_id:'fixture'} as AccountApiSession;
  const accounts={authenticate:async()=>session} as unknown as AccountApiRepository;
  const messages={accountId:()=>accountId} as unknown as JmapMessages;
  const drafts={query:async()=>({accountId,queryState:state,canCalculateChanges:false,position:0,ids:['draft_fixture'],limit:50}),
    get:async(_:unknown,args:Record<string,unknown>)=>{expect(args.ids).toEqual(['draft_fixture']);expect(args.properties).toEqual(['revision']);return {accountId,state,list:[{id:'draft_fixture',revision:1}],notFound:[]};}} as unknown as JmapDrafts;
  const app=new Hono();registerJmapRoutes(app,accounts,messages,'https://provider.example.com',undefined,drafts);
  const response=await app.request('https://provider.example.com/jmap',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(vector.request)});
  expect(response.status).toBe(200);expect((await response.json()).methodResponses).toEqual(vector.responses);
});
it('guards draft writes with scopes, passkeys, Origin and migration policy',async()=>{
  const session={account_id:'fixture',scopes:['messages:read','messages:write'],passkey_credential_id:'fixture',migration_state:null} as AccountApiSession;
  let authenticated=true,writes=0;
  const app=new Hono();registerJmapRoutes(app,{authenticate:async()=>authenticated?session:null} as unknown as AccountApiRepository,
    {accountId:()=> 'account_fixture'} as unknown as JmapMessages,'https://provider.example.com',undefined,
    {set:async()=>{writes++;return {accountId:'account_fixture'};}} as unknown as JmapDrafts);
  const body=JSON.stringify({using:['urn:ietf:params:jmap:core','https://haili.app/ns/jmap/drafts'],methodCalls:[['HailDraft/set',{accountId:'account_fixture'},'set']]});
  const post=(origin='https://provider.example.com')=>app.request('/jmap',{method:'POST',headers:{Cookie:'hail_session=fixture',Origin:origin,'Content-Type':'application/json'},body});
  authenticated=false;expect((await post()).status).toBe(401);authenticated=true;
  expect((await post('https://other.example.com')).status).toBe(403);
  session.scopes=['messages:read'];expect((await (await post()).json()).methodResponses[0]).toEqual(['error',{type:'forbidden'},'set']);
  session.scopes=['messages:read','messages:write'];session.passkey_credential_id=null;
  expect((await (await post()).json()).methodResponses[0][1].type).toBe('accountNotSupportedByMethod');
  session.passkey_credential_id='fixture';session.migration_state='fenced';
  expect((await (await post()).json()).methodResponses[0][1].type).toBe('forbidden');
  expect(writes).toBe(0);session.migration_state=null;
  expect((await (await post()).json()).methodResponses[0][0]).toBe('HailDraft/set');expect(writes).toBe(1);
});
