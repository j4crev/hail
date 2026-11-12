import {expect,it,vi} from 'vitest';
import {parseDraftContent} from '@racrproto/client-support/drafts';
const {request,readDraft,saveDraft}=vi.hoisted(()=>({request:vi.fn(),readDraft:vi.fn(),saveDraft:vi.fn()}));
vi.mock('$lib/server/jmap-drafts.js',()=>({readDraft,saveDraft}));
vi.mock('$lib/server/canary.js',()=>({canaryAccount:async()=>({account:{address:'me@example.com'},client:{request,jmap:request}})}));
import {actions,load} from '../routes/compose/+page.server.js';
const id='019a0000-0000-7000-8000-000000000001';
const content={audience:'category',category:'',connections:[],title:'',text:'',alt:'',caption:'',allowReply:false,header:null,forward:null};
it('permits incomplete drafts but rejects oversized and incompatible content',()=>{
  expect(parseDraftContent(content)).toEqual(content);
  for(const changes of [{text:'x'.repeat(65537)},{title:'é'.repeat(65)},{audience:'connections',header:'iVBORw0KGgo'},{forward:{sender:'untrusted',messageId:id}},{extra:true}])expect(()=>parseDraftContent({...content,...changes})).toThrow();
});
it('saves unfinished compose fields and resumes them on a new device',async()=>{
  request.mockReset();
  const saved={id,revision:1,content,updatedAt:'2026-11-03T00:00:00Z',trashedAt:null};
  saveDraft.mockResolvedValueOnce(saved);
  const form=new FormData();for(const [key,value] of Object.entries({publicationId:id,draftRevision:'0',audience:'category',text:'',title:''}))form.set(key,value);
  expect(await actions.save({request:new Request('https://example.com/compose',{method:'POST',body:form}),cookies:{},url:new URL('https://example.com/compose')} as never)).toEqual({savedDraft:saved});
  expect(saveDraft).toHaveBeenCalledWith({request,jmap:request},id,0,content);
  request.mockReset();readDraft.mockResolvedValueOnce(saved);request.mockResolvedValueOnce({maxRecipients:100,categories:[]});
  expect(await load({cookies:{},url:new URL(`https://example.com/compose?draft=${id}`)} as never)).toMatchObject({draft:saved,newPublicationId:id,kind:'category'});
});

import vectors from '../../../../spec/vectors/provider-drafts.json';
it('conforms to the provider draft content vectors',()=>{
  for(const example of vectors.valid)expect(parseDraftContent(example.content),example.name).toEqual(example.content);
  for(const example of vectors.invalid)expect(()=>parseDraftContent(example.content),example.name).toThrow();
});

it('sends a resumed PNG and draft revision without requiring a new file selection',async()=>{
  request.mockReset();request.mockRejectedValueOnce(new Error('Response lost'));
  const form=new FormData();
  for(const [key,value] of Object.entries({publicationId:id,draftRevision:'3',audience:'category',category:'general',title:'Headline',text:'Updated text',alt:'One pixel',savedHeader:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk-A8AAQUBAScY42YAAAAASUVORK5CYII'}))form.set(key,value);
  expect(await actions.publish({request:new Request('https://example.com/compose',{method:'POST',body:form}),cookies:{},url:new URL('https://example.com/compose')} as never)).toMatchObject({status:502,data:{publicationId:id}});
  expect(request).toHaveBeenCalledWith('HailSubmission/submit',{kind:'category',input:expect.objectContaining({publicationId:id,draftRevision:3,body:expect.objectContaining({profile:'spt-3',assets:expect.objectContaining({assets:[expect.objectContaining({width:1,height:1})]})})})});
});

it('saves and resumes rich drafts without converting them to simple compose text',async()=>{
  request.mockReset();
  const builder={version:1,body:{version:1,profile:'spt-2',blocks:[{_type:'block',style:'normal',children:[{_type:'span',text:'**Literal**',marks:['em','strong']}],markDefs:[]}]}};
  const saved={id,revision:2,content:{...content,builder},updatedAt:'2026-11-04T00:00:00Z',trashedAt:null};
  saveDraft.mockResolvedValueOnce(saved);
  const form=new FormData();for(const [key,value] of Object.entries({publicationId:id,draftRevision:'1',audience:'category',builder:JSON.stringify(builder)}))form.set(key,value);
  expect(await actions.save({request:new Request('https://example.com/compose',{method:'POST',body:form}),cookies:{},url:new URL('https://example.com/compose')} as never)).toEqual({savedDraft:saved});
  expect(saveDraft).toHaveBeenCalledWith({request,jmap:request},id,1,{...content,builder});
  request.mockReset();readDraft.mockResolvedValueOnce(saved);request.mockResolvedValueOnce({maxRecipients:100,categories:[]});
  expect(await load({cookies:{},url:new URL(`https://example.com/compose?draft=${id}`)} as never)).toMatchObject({draft:saved});
});

it('saves and resumes an unfinished builder header but rejects publishing it',async()=>{
  const incomplete=vectors.valid.find(v=>v.name==='builder-unfinished-header-description')!.content;
  const saved={id,revision:1,content:incomplete,updatedAt:'2026-11-05T00:00:00Z',trashedAt:null};
  const form=new FormData();for(const [key,value] of Object.entries({publicationId:id,draftRevision:'0',audience:'category',category:'general',builder:JSON.stringify(incomplete.builder)}))form.set(key,value);
  request.mockReset();saveDraft.mockResolvedValueOnce(saved);
  expect(await actions.save({request:new Request('https://example.com/compose',{method:'POST',body:form}),cookies:{},url:new URL('https://example.com/compose')} as never)).toEqual({savedDraft:saved});
  expect(saveDraft).toHaveBeenCalledWith({request,jmap:request},id,0,{...incomplete,category:'general'});
  request.mockReset();readDraft.mockResolvedValueOnce(saved);request.mockResolvedValueOnce({maxRecipients:100,categories:[]});
  expect(await load({cookies:{},url:new URL(`https://example.com/compose?draft=${id}`)} as never)).toMatchObject({draft:saved});
  request.mockReset();
  expect(await actions.publish({request:new Request('https://example.com/compose',{method:'POST',body:form}),cookies:{},url:new URL('https://example.com/compose')} as never)).toMatchObject({status:400});
  expect(request).not.toHaveBeenCalled();
});

it('loads the builder by default and falls back without writing an unconvertible legacy draft',async()=>{
  request.mockReset();request.mockResolvedValueOnce({maxRecipients:100,categories:[]});
  expect(await load({cookies:{},url:new URL('https://example.com/compose')} as never)).toMatchObject({builderInitial:{version:1,body:{version:1,profile:'spt-2',blocks:[]}},builderFallback:false});
  const saved={id,revision:3,content:{...content,header:'iVBORw0KGgo',text:'Keep this'},updatedAt:'2026-11-05T00:00:00Z',trashedAt:null};
  request.mockReset();readDraft.mockResolvedValueOnce(saved);request.mockResolvedValueOnce({maxRecipients:100,categories:[]});
  expect(await load({cookies:{},url:new URL(`https://example.com/compose?draft=${id}`)} as never)).toMatchObject({draft:saved,builderInitial:null,builderFallback:true});
  expect(readDraft).toHaveBeenCalledWith({request,jmap:request},id);expect(request.mock.calls).toEqual([['HailSubmission/audiences']]);
});

it('uses the simple composer for new and saved Connections messages',async()=>{
  const connectionContent={...content,audience:'connections',text:'**Hello**\n\n- One'};
  const saved={id,revision:1,content:connectionContent,updatedAt:'2026-11-06T00:00:00Z',trashedAt:null};
  for(const draft of [null,saved]){
    request.mockReset();if(draft)readDraft.mockResolvedValueOnce(draft);
    request.mockResolvedValueOnce({maxRecipients:100,categories:[]}).mockResolvedValueOnce({maxRecipients:100,connections:[]});
    expect(await load({cookies:{},url:new URL(`https://example.com/compose?audience=connections${draft?`&draft=${id}`:''}`)} as never)).toMatchObject({kind:'connections',builderInitial:null,builderFallback:false,draft});
  }
  request.mockReset();saveDraft.mockResolvedValueOnce(saved);
  const form=new FormData();for(const [key,value] of Object.entries({publicationId:id,draftRevision:'0',audience:'connections',text:connectionContent.text}))form.set(key,value);
  expect(await actions.save({request:new Request('https://example.com/compose',{method:'POST',body:form}),cookies:{},url:new URL('https://example.com/compose')} as never)).toEqual({savedDraft:saved});
  expect(saveDraft).toHaveBeenCalledWith({request,jmap:request},id,0,{...connectionContent,text:connectionContent.text.replaceAll('\n','\r\n')});
});

it('preserves existing block-based Connection drafts on load and refuses builder saves',async()=>{
  const builder={version:1,body:{version:1,profile:'spt-2',blocks:[{_type:'block',style:'normal',children:[{_type:'span',text:'Keep **literal** text',marks:[]}],markDefs:[]}]}};
  const saved={id,revision:3,content:{...content,audience:'connections',builder},updatedAt:'2026-11-06T00:00:00Z',trashedAt:null};
  request.mockReset();readDraft.mockResolvedValueOnce(saved);request.mockResolvedValueOnce({maxRecipients:100,categories:[]}).mockResolvedValueOnce({maxRecipients:100,connections:[]});
  expect(await load({cookies:{},url:new URL(`https://example.com/compose?draft=${id}`)} as never)).toMatchObject({draft:saved,builderInitial:null,builderFallback:false});
  expect(request.mock.calls.every(call=>call.length===1)).toBe(true);
  request.mockReset();
  const form=new FormData();for(const [key,value] of Object.entries({publicationId:id,draftRevision:'3',audience:'connections',builder:JSON.stringify(builder)}))form.set(key,value);
  expect(await actions.save({request:new Request('https://example.com/compose',{method:'POST',body:form}),cookies:{},url:new URL('https://example.com/compose')} as never)).toMatchObject({status:400,data:{error:'The block builder is available for subscriber publications only.'}});
  expect(request).not.toHaveBeenCalled();
});
