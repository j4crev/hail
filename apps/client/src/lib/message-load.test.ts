import {beforeEach,expect,it,vi} from 'vitest';
import {AccountApiError} from '@racrproto/client-support/account-api';
const fixture=vi.hoisted(()=>({batch:vi.fn(),jmap:vi.fn(),grant:vi.fn(),custody:'managed'}));
vi.mock('$env/dynamic/private',()=>({env:{}}));
vi.mock('$lib/server/canary.js',()=>({
  canaryAccount:async()=>({account:{did:'did:plc:'+'o'.repeat(24),custodyProfile:fixture.custody},client:{jmapBatch:fixture.batch,jmap:fixture.jmap,grant:fixture.grant}}),
  senderAvatars:async()=>new Map(),
}));
import {load} from './server/mailbox/message.js';
const sender='did:plc:'+'s'.repeat(24),messageId='01890a5d-ac96-7b4c-8b4a-123456789abc';
const message=(extra:Record<string,unknown>={})=>({messageId,sender,recipient:'did:plc:'+'o'.repeat(24),deliveredAt:'2026-11-12T00:00:00.000Z',
  isRead:false,trashedAt:null,category:null,senderAddress:'news@example.com',body:{version:1,profile:'spt-1',blocks:[]},...extra});
const thread={messages:[{sender,messageId,sent:false,isRead:false,createdAt:'2026-11-12T00:00:00.000Z',preview:'Hello',inReplyTo:null,parentAvailable:false}],truncated:false};
const event=()=>({params:{sender,messageId},cookies:{get:()=>undefined},url:new URL('https://gui.example/message')});
beforeEach(()=>{fixture.batch.mockReset();fixture.jmap.mockReset();fixture.grant.mockReset();fixture.custody='managed';});

it('reads the message, its thread and the sender subscriptions in one provider request',async()=>{
  fixture.batch.mockResolvedValue([message(),thread,{grants:[],next:null}]);
  const result=await load(event() as never);
  expect(fixture.batch).toHaveBeenCalledExactlyOnceWith([
    ['HailMailbox/view',{view:'read',sender,messageId,images:'reference'}],
    ['HailMailbox/view',{view:'threads',sender,messageId}],
    ['HailGrant/list',{sender}],
  ]);
  expect(fixture.jmap).not.toHaveBeenCalled();
  expect(result).toMatchObject({message:{messageId,sender},thread,threadUnavailable:false,subscription:null,subscriptionUnavailable:false});
});

it('keeps the message readable when its thread or subscriptions fail',async()=>{
  fixture.batch.mockResolvedValue([message(),new AccountApiError(503),new AccountApiError(503)]);
  expect(await load(event() as never)).toMatchObject({message:{messageId},thread:null,threadUnavailable:true,subscription:null,subscriptionUnavailable:true});
});

it('skips the subscription lookup for non-managed accounts and the thread for Trash',async()=>{
  fixture.custody='owner-controlled';
  fixture.batch.mockResolvedValue([message({trashedAt:'2026-11-12T01:00:00.000Z'}),new AccountApiError(404)]);
  expect(await load(event() as never)).toMatchObject({thread:null,threadUnavailable:false,subscription:null,subscriptionUnavailable:false});
  expect(fixture.batch.mock.calls[0]![0]).toHaveLength(2);
});

it('propagates a provider failure to read the message itself',async()=>{
  fixture.batch.mockResolvedValue([new AccountApiError(429,7),thread,{grants:[],next:null}]);
  await expect(load(event() as never)).rejects.toMatchObject({status:429,retryAfterSeconds:7});
});
