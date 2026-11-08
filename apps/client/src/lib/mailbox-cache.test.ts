import {expect,it,vi} from 'vitest';
import {MailboxCache,StaleMailboxRead} from './mailbox-cache.js';
import {appendMailbox,appendRows} from './mailbox-history.js';

it('deduplicates reads, isolates account/query keys and bounds retained content',async()=>{
  const cache=new MailboxCache(1000,2),read=vi.fn(async()=>({messages:['one']}));
  const [a,b]=await Promise.all([cache.request('account-a:feed',read),cache.request('account-a:feed',read)]);
  expect(a).toBe(b);expect(read).toHaveBeenCalledTimes(1);
  expect(cache.get('account-b:feed')).toBeUndefined();
  await cache.request('account-a:sent',async()=>2);
  await cache.request('account-a:trash',async()=>3);
  expect(cache.get('account-a:feed')).toBeUndefined();
  await cache.request('large',async()=>'x'.repeat(1000));
  expect(cache.get('large')).toBeUndefined();
});
it('rejects a refresh that completes after a mutation and does not erase a newer request',async()=>{
  const cache=new MailboxCache();let finish!:(v:string)=>void;
  const old=cache.request('feed',()=>new Promise<string>(resolve=>finish=resolve));
  cache.clear();
  await cache.request('feed',async()=>'new');
  finish('old');await expect(old).rejects.toBeInstanceOf(StaleMailboxRead);
  expect(cache.get('feed')).toBe('new');
});
it('does not cache a read while a mutation is still in flight; expires old content',async()=>{
  const cache=new MailboxCache();cache.mutations++;
  await expect(cache.request('feed',async()=>1)).rejects.toBeInstanceOf(StaleMailboxRead);
  cache.mutations--;await cache.request('feed',async()=>2);
  vi.spyOn(Date,'now').mockReturnValue(Date.now()+300_001);
  expect(cache.get('feed')).toBeUndefined();vi.restoreAllMocks();
});
it('deduplicates changed conversation representatives using member overlap and shared identity',()=>{
  const member={sender:'alice',messageId:'one'};
  const initial={...member,conversation:{messages:[member]}};
  const changed={sender:'bob',messageId:'two',conversation:{messages:[member,{sender:'bob',messageId:'two'}]}};
  expect(appendRows([initial],[changed])).toEqual([initial]);
  const sharedConversation={creator:'alice',conversationId:'group'};
  expect(appendRows([{...initial,sharedConversation}],[{...changed,conversation:undefined,sharedConversation}])).toHaveLength(1);
  expect(appendRows([member],[member,{sender:'bob',messageId:'one'}])).toHaveLength(2);
});
it('appends Trash streams independently without replacing other streams or their cursors',()=>{
  const before={messages:[{sender:'a',messageId:'1'}],next:'received' as string|null,sent:{messages:[{kind:'category',messageId:'2'}],next:'sent' as string|null},drafts:{drafts:[{id:'3'}],next:'draft' as string|null}};
  const incoming={messages:[],next:null,sent:{messages:[{kind:'category',messageId:'4'}],next:null},drafts:{drafts:[],next:null}};
  const result=appendMailbox(before,incoming,'sentAfter');
  expect(result.messages).toBe(before.messages);expect(result.drafts).toBe(before.drafts);expect(result.next).toBe('received');
  expect(result.sent.messages).toHaveLength(2);expect(result.sent.next).toBeNull();
});
it('holds navigation until all overlapping mutations have settled',async()=>{
  const cache=new MailboxCache();cache.beginMutation();cache.beginMutation();
  let settled=false;const navigation=cache.idle().then(()=>{settled=true;});
  cache.endMutation();await Promise.resolve();expect(settled).toBe(false);
  cache.endMutation();await navigation;expect(settled).toBe(true);
});
