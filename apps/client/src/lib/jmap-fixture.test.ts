import {expect,it} from 'vitest';
import {jmapReadFixture} from '../../scripts/jmap-read-fixture.js';
it('keeps local preview read state on the JMAP workflow',async()=>{
  const row={sender:'did:plc:'+'a'.repeat(24),messageId:'019a0000-0000-7000-8000-000000000001',isRead:false};
  const fixture=jmapReadFixture(()=>[row],(_,value)=>{row.isRead=value;});
  const query=await fixture('/api/jmap','POST',{methodCalls:[['HailMessage/query',{accountId:'fixture_account',filter:{sender:row.sender,messageId:row.messageId}},'q']]})!.json();
  const {ids,queryState}=query.methodResponses[0][1];
  const update={accountId:'fixture_account',ifInState:queryState,update:{[ids[0]]:{isRead:true}}};
  const changed=await fixture('/api/jmap','POST',{methodCalls:[['HailMessage/set',update,'s']]})!.json();
  expect(changed.methodResponses[0][1].updated).toHaveProperty(ids[0],null);expect(row.isRead).toBe(true);
  const stale=await fixture('/api/jmap','POST',{methodCalls:[['HailMessage/set',update,'s']]})!.json();
  expect(stale.methodResponses[0]).toEqual(['error',{type:'stateMismatch'},'s']);
});
