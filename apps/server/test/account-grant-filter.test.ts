import {JmapMessages} from '../src/jmap/messages.js';
import {expect,it,vi} from "vitest";
import {createApp} from "../src/app.js";
import type {AppConfig} from "../src/config.js";
import type {AccountApiRepository} from "../src/accounts/repository.js";
import type {GrantRepository} from "../src/grants/repository.js";
import type {GrantService} from "../src/grants/service.js";
it("validates sender filtering and retains account-scoped grant authorization",async()=>{
  const session={account_id:crypto.randomUUID(),scopes:["grants:read"],serving_generation:1};
  const listGrants=vi.fn(async()=>({grants:[],next:null}));
  const app=createApp({publicOrigin:"https://example.com",hailServiceBase:"https://example.com/hail",providerId:"test"} as AppConfig,
    {jmap:new JmapMessages({} as never,"https://example.com"),accountApi:{accounts:{authenticate:async()=>session,listGrants} as unknown as AccountApiRepository,grants:{} as GrantRepository,service:{} as GrantService},async checkReadiness(){return {ready:true};}});
  const sender=`did:plc:${"a".repeat(24)}`;
  const get=async(args:Record<string,unknown>)=>{
    const response=await app.request('/jmap',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({using:['urn:ietf:params:jmap:core','https://racrproto.com/ns/jmap/account'],methodCalls:[['HailGrant/list',{accountId:new JmapMessages({} as never,'https://example.com').accountId(session as never),...args},'test']]})});
    const data=await response.json() as any;return data.methodResponses[0];
  };
  expect((await get({sender}))[0]).toBe('HailGrant/list');
  expect(listGrants).toHaveBeenLastCalledWith(session,null,sender);
  expect((await get({}))[0]).toBe('HailGrant/list');expect(listGrants).toHaveBeenLastCalledWith(session,null,null);
  for(const args of [{sender:'bad'},{after:'bad'},{sender,extra:1}])expect((await get(args))[1].type).toBe('invalidArguments');
  session.scopes=[];expect((await get({sender}))[1].type).toBe('forbidden');
  expect(listGrants).toHaveBeenCalledTimes(2);
});
