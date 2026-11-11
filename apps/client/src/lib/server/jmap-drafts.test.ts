import {expect,it,vi} from 'vitest';
import {listDrafts,readDraft,saveDraft} from './jmap-drafts.js';
import type {AccountApiClient} from '@racrproto/client-support/account-api';
import {jmapReadFixture} from '../../../scripts/jmap-read-fixture.js';
import type {Draft} from '@racrproto/client-support/drafts';
const id='019a0000-0000-7000-8000-000000000001';
const content={audience:'category' as const,category:'',connections:[],title:'',text:'unfinished',alt:'',caption:'',allowReply:false,header:null,forward:null};
function fixture(){
  const drafts=new Map<string,Draft>(),handler=jmapReadFixture(()=>[],()=>{},()=>true,()=>{},drafts);
  const request=vi.fn(async(path:string,body?:Record<string,unknown>,namespace?:string)=>{
    expect(namespace).toBe('');
    const response=handler(path==='/.well-known/jmap'?'/api/jmap/session':'/api/jmap',body?'POST':'GET',body??{});
    return response!.json();
  });
  return {drafts,request,client:{request} as unknown as AccountApiClient};
}
it('saves, resumes and lists exact draft content through JMAP',async()=>{
  const {client,request}=fixture();
  const saved=await saveDraft(client,id,0,content);expect(saved).toMatchObject({id,content,revision:1});
  expect(await readDraft(client,id)).toEqual(saved);
  expect(await listDrafts(client,null)).toEqual({drafts:[saved],next:null});
  expect(await saveDraft(client,id,1,{...content,text:'edited'})).toMatchObject({revision:2,content:{...content,text:'edited'}});
  await expect(saveDraft(client,id,1,content)).rejects.toMatchObject({status:409});
  expect(request.mock.calls.every(([path])=>path==='/.well-known/jmap'||path==='/jmap')).toBe(true);
});
it('rejects an edit raced after the client revision check without retrying',async()=>{
  const {client,request,drafts}=fixture();await saveDraft(client,id,0,content);
  const original=request.getMockImplementation()!;
  request.mockImplementation(async(path,body,namespace)=>{
    if(body?.methodCalls&&(body.methodCalls as any)[0][0]==='HailDraft/set')drafts.get(id)!.revision++;
    return original(path,body,namespace);
  });
  await expect(saveDraft(client,id,1,{...content,text:'lost race'})).rejects.toMatchObject({status:409});
  expect(drafts.get(id)!.content).toEqual(content);
});
it('uses the computed revision after an unchanged conditional save',async()=>{
  const {client,request}=fixture();const saved=await saveDraft(client,id,0,content);
  const original=request.getMockImplementation()!;
  request.mockImplementation(async(path,body,namespace)=>{
    if(body?.methodCalls&&(body.methodCalls as any)[0][0]==='HailDraft/set'){
      const [,args,tag]=(body.methodCalls as any)[0],key=Object.keys(args.update)[0];
      return {methodResponses:[['HailDraft/set',{accountId:args.accountId,oldState:args.ifInState,newState:args.ifInState,updated:{[key]:null}},tag]]};
    }
    return original(path,body,namespace);
  });
  expect(await saveDraft(client,id,1,content)).toEqual(saved);
});
