import {beforeEach,expect,it,vi} from 'vitest';
import {AccountApiError} from '@racrproto/client-support/account-api';
const fixture=vi.hoisted(()=>({request:vi.fn(),configured:true}));
vi.mock('$env/dynamic/private',()=>({env:{}}));
vi.mock('$lib/server/canary.js',()=>({isConfigured:()=>fixture.configured,canaryAccount:async()=>({account:{did:'did:plc:test'},client:{jmap:fixture.request,
  // One batched provider request; each method's failure is its own result.
  jmapBatch:(calls:[string,unknown][])=>Promise.all(calls.map(([name,args])=>Promise.resolve(fixture.request(name,args)).catch((cause:unknown)=>{if(cause instanceof AccountApiError)return cause;throw cause;})))}})}));
import {load} from '../routes/+layout.server.js';
const event=()=>({cookies:{get:()=>"test-session"},url:new URL('https://example.com/sent'),depends:vi.fn()});
beforeEach(()=>{fixture.configured=true;fixture.request.mockReset();});
it('loads both totals on non-inbox pages and subscribes to read/cleanup invalidation',async()=>{
  fixture.request.mockResolvedValue({subscriptions:72,connections:9});
  const input=event();
  expect(await load(input as never)).toMatchObject({unreadCounts:{subscriptions:72,connections:9}});
  expect(input.depends).toHaveBeenCalledWith('hail:mailbox');
  expect(fixture.request).toHaveBeenCalledWith('HailMailbox/view',{view:'unreadCounts'});
});
it('omits unavailable or malformed counts without blocking the layout',async()=>{
  for(const counts of [{subscriptions:-1,connections:0},{subscriptions:0.5,connections:0},{}]){
    fixture.request.mockResolvedValue(counts);
    expect((await load(event() as never)).unreadCounts).toBeNull();
  }
  fixture.request.mockRejectedValue(new Error('offline'));
  expect(await load(event() as never)).toMatchObject({unreadCounts:null,accountAvatar:{did:'did:plc:test'}});
});
it('does not fetch totals without a session',async()=>{
  fixture.configured=false;
  expect((await load(event() as never)).unreadCounts).toBeNull();
  expect(fixture.request).not.toHaveBeenCalled();
});

it('loads an independent unseen-connection count and rejects malformed values',async()=>{
  for(const value of [0,2,101]){
    fixture.request.mockResolvedValue({subscriptions:7,connections:3,unseenConnections:value});
    expect(await load(event() as never)).toMatchObject({unreadCounts:{subscriptions:7,connections:3},unseenConnections:value});
  }
  for(const value of [undefined,-1,0.5,'2',null]){
    fixture.request.mockResolvedValue({subscriptions:7,connections:3,unseenConnections:value});
    expect((await load(event() as never)).unseenConnections).toBeNull();
  }
});
