import {beforeEach,expect,it,vi} from 'vitest';
vi.mock('$lib/server/jmap-drafts.js',()=>({listDrafts:async()=>({drafts:[],next:null})}));
const fixture=vi.hoisted(()=>({jmap:vi.fn(),avatars:vi.fn()}));
vi.mock('$lib/server/canary.js',()=>({canaryAccount:async()=>({account:{did:'owner'},client:{jmap:fixture.jmap}}),senderAvatars:fixture.avatars}));
import {load as trash} from './server/mailbox/trash.js';
import {load as connections} from '../routes/connections/+page.server.js';
const event=()=>({url:new URL('https://example.com/'),cookies:{},setHeaders:vi.fn()}) as never;
beforeEach(()=>{vi.resetAllMocks();fixture.avatars.mockResolvedValue(new Map([['sender',{src:'data:image/png;base64,AQID',width:44,height:44}]]));});
it('adds sender avatars to Trash without changing restoration identity',async()=>{
  fixture.jmap.mockResolvedValueOnce({messages:[{sender:'sender',messageId:'message',recipient:'owner',deliveredAt:'2026-10-27T12:00:00Z',trashedAt:'2026-10-28T12:00:00Z',category:null,body:{version:1,profile:'spt-1',blocks:[]}}],next:null});
  fixture.jmap.mockResolvedValueOnce({trashEnabled:true}).mockResolvedValueOnce({messages:[],next:null});
  const result=await trash(event());
  expect(result.messages[0]).toMatchObject({sender:'sender',messageId:'message',avatar:{width:44}});
  expect(fixture.avatars.mock.calls[0][1]).toEqual(new Set(['sender']));
  expect(fixture.jmap.mock.calls).toEqual([
    ['HailMailbox/view',{view:'inboxFeed',after:null,trash:true,images:'reference'},2_000_000],
    ['HailMailbox/view',{view:'settings'}],
    ['HailMailbox/view',{view:'sentSends',trash:true,after:null},2_000_000],
  ]);
});
it('loads connection portraits and preserves the component retry path on API failure',async()=>{
  fixture.jmap.mockResolvedValue({preview:true,codes:[],connections:[{id:'id',did:'sender',address:'sender@example.com'}]});
  expect(await connections(event())).toMatchObject({initialList:{connections:[{did:'sender'}]},avatars:{sender:{width:44}}});
  expect(fixture.jmap).toHaveBeenCalledExactlyOnceWith('HailRelationship/list');
  fixture.jmap.mockRejectedValue(new Error('Unavailable'));fixture.avatars.mockResolvedValue(new Map());
  expect(await connections(event())).toMatchObject({initialList:null,avatars:{}});
});
it('separates Trash subjects from previews while retaining restore identity and dates',async()=>{
  const block=(style:string,text:string)=>({_type:'block',style,children:[{_type:'span',text,marks:[]}],markDefs:[]});
  fixture.jmap.mockResolvedValueOnce({messages:[{sender:'sender',messageId:'message',recipient:'owner',deliveredAt:'2026-10-27T12:00:00Z',trashedAt:'2026-10-28T12:00:00Z',category:null,kind:'connection',body:{version:1,profile:'spt-2',blocks:[block('h1','Weekend plans'),block('normal','See you Saturday.')]}}],next:'next-page'});
  fixture.jmap.mockResolvedValueOnce({trashEnabled:true}).mockResolvedValueOnce({messages:[],next:null});
  const pagedEvent={url:new URL('https://example.com/trash?after=received-page&sentAfter=sent-page'),cookies:{}} as never;
  const result=await trash(pagedEvent);
  expect(fixture.jmap).toHaveBeenNthCalledWith(1,'HailMailbox/view',{view:'inboxFeed',after:'received-page',trash:true,images:'reference'},2_000_000);
  expect(fixture.jmap).toHaveBeenNthCalledWith(3,'HailMailbox/view',{view:'sentSends',trash:true,after:'sent-page'},2_000_000);
  expect(result).toMatchObject({paged:true,sentPaged:true,next:'next-page',messages:[{sender:'sender',messageId:'message',kind:'connection',deliveredAt:'2026-10-27T12:00:00Z',trashedAt:'2026-10-28T12:00:00Z',title:'Weekend plans',preview:'See you Saturday.',avatar:{width:44}}]});
});
