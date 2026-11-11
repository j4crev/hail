import {AccountApiError,type AccountApiClient} from '@racrproto/client-support/account-api';
import {parseDraft,type DraftContent} from '@racrproto/client-support/drafts';
const CORE='urn:ietf:params:jmap:core',DRAFTS='https://racrproto.com/ns/jmap/drafts';
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
async function connection(client:AccountApiClient){
  const session=await client.request('/.well-known/jmap',undefined,'');
  const accountId=object(session.primaryAccounts)?session.primaryAccounts[DRAFTS]:null;
  if(typeof accountId!=='string')throw new AccountApiError(403);
  return async(name:string,args:Record<string,unknown>)=>{
    const response=await client.request('/jmap',{using:[CORE,DRAFTS],methodCalls:[[name,{accountId,...args},'draft']]},'',2_100_000);
    const calls=response.methodResponses;
    if(!Array.isArray(calls)||calls.length!==1||!Array.isArray(calls[0])||calls[0][2]!=='draft'||!object(calls[0][1]))throw new Error('Invalid JMAP draft response');
    if(calls[0][0]==='error')throw new AccountApiError(calls[0][1].type==='stateMismatch'?409:400);
    if(calls[0][0]!==name||calls[0][1].accountId!==accountId)throw new Error('Invalid JMAP draft response');
    return calls[0][1];
  };
}
const draft=(value:unknown)=>{
  if(!object(value)||typeof value.id!=='string'||!/^d_[0-9a-f]{32}$/.test(value.id))throw new Error('Invalid JMAP draft');
  return parseDraft({...value,id:value.draftId});
};
async function find(call:Awaited<ReturnType<typeof connection>>,id:string){
  const query=await call('HailDraft/query',{filter:{draftId:id,inTrash:false},limit:2});
  if(!Array.isArray(query.ids)||query.ids.length>1||typeof query.queryState!=='string')throw new Error('Invalid JMAP draft query');
  if(!query.ids.length)return {record:null,state:query.queryState};
  const result=await call('HailDraft/get',{ids:query.ids});
  if(typeof result.state!=='string'||!Array.isArray(result.list)||result.list.length!==1)throw new AccountApiError(409);
  const record=result.list[0];
  if(!object(record)||record.id!==query.ids[0]||record.draftId!==id||record.isInTrash!==false)throw new AccountApiError(409);
  return {record,state:result.state};
}
export async function readDraft(client:AccountApiClient,id:string){
  const {record}=await find(await connection(client),id);if(!record)throw new AccountApiError(404);return draft(record);
}
export async function saveDraft(client:AccountApiClient,id:string,revision:number,content:DraftContent){
  const call=await connection(client),{record,state}=await find(call,id);
  if((record?.revision??0)!==revision)throw new AccountApiError(409);
  const result=await call('HailDraft/set',{ifInState:state,...(record?{update:{[record.id as string]:{content}}}:{create:{saved:{draftId:id,content}}})});
  const values=record?result.updated:result.created,key=record?record.id:'saved';
  if(!object(values)||typeof key!=='string'||!Object.hasOwn(values,key)||!(object(values[key])||record&&values[key]===null))throw new AccountApiError(409);
  const computed=values[key]??{};
  return draft({...(record??{}),...computed,draftId:id,content,isInTrash:false,trashedAt:null});
}
export async function listDrafts(client:AccountApiClient,anchor:string|null,trash=false){
  const call=await connection(client);
  const query=await call('HailDraft/query',{filter:{inTrash:trash},limit:50,calculateTotal:true,...(anchor?{anchor,anchorOffset:1}:{})});
  if(!Array.isArray(query.ids)||query.ids.some(id=>typeof id!=='string')||typeof query.queryState!=='string'||typeof query.position!=='number'||typeof query.total!=='number')throw new Error('Invalid JMAP draft query');
  // Four maximum-size drafts fit below the advertised 2 MiB get limit.
  const drafts=[];
  for(let offset=0;offset<query.ids.length;offset+=4){
    const ids=query.ids.slice(offset,offset+4),result=await call('HailDraft/get',{ids});
    if(result.state!==query.queryState)throw new AccountApiError(409);
    if(!Array.isArray(result.list)||result.list.length!==ids.length)throw new Error('Invalid JMAP draft result');
    for(const id of ids){
      const row=result.list.find(row=>object(row)&&row.id===id);if(!row)throw new Error('Invalid JMAP draft result');
      drafts.push(draft(row));
    }
  }
  return {drafts,next:query.position+query.ids.length<query.total?query.ids.at(-1) as string:null};
}
