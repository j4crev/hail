import {beforeEach,expect,it,vi} from "vitest";
import {AccountApiError} from "@racrproto/client-support/account-api";
const {request}=vi.hoisted(()=>({request:vi.fn()}));
vi.mock("$lib/server/canary.js",()=>({canaryAccount:async()=>({account:{provider:"https://example.com"},client:{request}})}));
import {load} from "../routes/admin/+page.server.js";
beforeEach(()=>request.mockReset());
const event=(query="")=>({cookies:{},url:new URL(`https://example.com/admin${query}`)}) as Parameters<typeof load>[0];
it("loads the selected activity range and preserves invitations",async()=>{
  const invitations=[{id:"invitation"}],stats={range:"week",activity:[]};
  request.mockResolvedValueOnce({invitations}).mockResolvedValueOnce(stats).mockResolvedValueOnce({mode:"invite"});
  expect(await load(event("?range=week"))).toMatchObject({invitations,stats,range:"week",signupMode:"invite"});
  expect(request).toHaveBeenCalledWith("/stats?range=week",undefined,"/api/v1/operator");
});
it("defaults invalid ranges and keeps invitation tools available on temporary stats failure",async()=>{
  request.mockResolvedValueOnce({invitations:[]}).mockRejectedValueOnce(new AccountApiError(503)).mockResolvedValueOnce({mode:"public"});
  expect(await load(event("?range=invalid"))).toMatchObject({invitations:[],stats:null,range:"day",signupMode:"public"});
});
it("does not hide operator authorization failures",async()=>{
  request.mockResolvedValueOnce({invitations:[]}).mockRejectedValueOnce(new AccountApiError(403));
  await expect(load(event())).rejects.toMatchObject({status:403});
});
it("lists service accounts and treats a provider without them as unavailable",async()=>{
  const serviceAccounts={accounts:[{address:"admin@example.com",accountId:"a",did:null,state:"active",active:true,operator:true,passkeys:1}],
    available:["abuse"],recoveryKeySet:true};
  request.mockResolvedValueOnce({invitations:[]}).mockResolvedValueOnce({range:"day",activity:[]}).mockResolvedValueOnce({mode:"invite"})
    .mockResolvedValueOnce(serviceAccounts);
  expect(await load(event())).toMatchObject({serviceAccounts});
  expect(request).toHaveBeenLastCalledWith("/service-accounts",undefined,"/api/v1/operator");
  request.mockResolvedValueOnce({invitations:[]}).mockResolvedValueOnce({range:"day",activity:[]}).mockResolvedValueOnce({mode:"invite"})
    .mockRejectedValueOnce(new AccountApiError(404));
  expect(await load(event())).toMatchObject({serviceAccounts:null});
});
