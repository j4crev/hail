import type {Draft} from '@racrproto/client-support/drafts';
import {jmapDraftFixture} from './jmap-draft-fixture.js';
const json=(value:unknown)=>Response.json(value,{headers:{'Content-Type':'application/json'}});
// Fictional read-state provider shared by local preview and browser scenarios.
// This is not a compatibility implementation or a production provider.
export function jmapReadFixture(rows:()=>{sender:string;messageId:string;isRead:boolean;trashedAt?:string|null}[],write:(id:string,value:boolean)=>void,trashEnabled=()=>true,trashWrite:(id:string,value:boolean|null)=>void=()=>{},drafts=new Map<string,Draft>(),operation?:(name:string,args:Record<string,any>)=>Record<string,unknown>){
  const draftFixture=jmapDraftFixture(drafts,trashEnabled);
  const accountCapability='https://racrproto.com/ns/jmap/account';
  const capability='https://racrproto.com/ns/jmap/messages',accountId='fixture_account';let revision=0;
  return (path:string,method:string,input:Record<string,any>):Response|null=>{
    if(path==='/api/jmap/session'&&method==='GET')return json({capabilities:{'urn:ietf:params:jmap:core':{},[capability]:{},[draftFixture.capability]:{},...(operation?{[accountCapability]:{version:1,types:['HailSent','HailSubmission','HailGrant','HailRelationship']}}:{})},primaryAccounts:{[capability]:accountId,[draftFixture.capability]:accountId,...(operation?{[accountCapability]:accountId}:{})},
      accounts:{[accountId]:{isReadOnly:false,accountCapabilities:{...(operation?{[accountCapability]:{types:['HailSent','HailSubmission','HailGrant','HailRelationship']}}:{}),[capability]:{mutableProperties:['isRead','isInTrash'],canDestroy:true}}}}});
    if(path!=='/api/jmap'||method!=='POST')return null;
    const responses=(input.methodCalls??[]).map(([name,args,tag]:[string,Record<string,any>,string])=>{
      const error=(type:string)=>['error',{type},tag];
      if(args.accountId!==accountId)return error('accountNotFound');
      if(operation&&/^(HailMailbox|HailSubmission|HailGrant|HailRelationship)\//.test(name)){
        try{return [name,{accountId,...operation(name,args)},tag];}
        catch(cause){const e=cause as Error&{httpStatus?:number;type?:string};return ['error',{type:e.type??'serverFail',httpStatus:e.httpStatus??500,description:e.message},tag];}
      }
      if(name.startsWith('HailDraft/')){try{return [name,draftFixture.call(name,args),tag];}catch(cause){return error(cause instanceof Error?cause.message:'serverFail');}}
      if(name==='HailMessage/query')return [name,{accountId,queryState:String(revision),canCalculateChanges:false,position:0,
        ids:rows().filter(row=>row.sender===args.filter?.sender&&row.messageId===args.filter?.messageId&&(args.filter?.inTrash===undefined||!!row.trashedAt===args.filter.inTrash)).map(row=>'m_'+row.messageId.replaceAll('-',''))},tag];
      if(name!=='HailMessage/set')return error('unknownMethod');
      if(args.ifInState!==String(revision))return error('stateMismatch');
      if(args.ifTrashEnabled!==undefined&&args.ifTrashEnabled!==trashEnabled())return error('stateMismatch');
      const oldState=String(revision),updated:Record<string,null>={},notUpdated:Record<string,unknown>={};
      for(const [id,patch] of Object.entries(args.update??{}) as [string,{isRead?:unknown;isInTrash?:unknown}][]){
        const row=rows().find(row=>'m_'+row.messageId.replaceAll('-','')===id);
        if(!row){notUpdated[id]={type:'notFound'};continue;}
        if(patch.isInTrash!==undefined){
          if(typeof patch.isInTrash!=='boolean'||!trashEnabled()){notUpdated[id]={type:'forbidden'};continue;}
          if(!!row.trashedAt!==patch.isInTrash){trashWrite(row.messageId,patch.isInTrash);revision++;}
        }else if(typeof patch.isRead==='boolean'){
          if(row.isRead!==patch.isRead){write(row.messageId,patch.isRead);revision++;}
        }else {notUpdated[id]={type:'invalidProperties'};continue;}
        updated[id]=null;
      }
      const destroyed:string[]=[],notDestroyed:Record<string,unknown>={};
      for(const id of args.destroy??[]){
        const row=rows().find(row=>'m_'+row.messageId.replaceAll('-','')===id);
        if(!row){notDestroyed[id]={type:'notFound'};continue;}
        if(trashEnabled()&&!row.trashedAt){notDestroyed[id]={type:'forbidden'};continue;}
        trashWrite(row.messageId,null);destroyed.push(id);revision++;
      }
      return [name,{accountId,oldState,newState:String(revision),destroyed:destroyed.length?destroyed:null,notDestroyed:Object.keys(notDestroyed).length?notDestroyed:null,updated:Object.keys(updated).length?updated:null,notUpdated:Object.keys(notUpdated).length?notUpdated:null},tag];
    });
    return json({methodResponses:responses,sessionState:'fixture'});
  };
}

export async function fixtureMessageMutation(origin:string,message:{sender:string;messageId:string},patch:Record<string,boolean>|null){
  const capability='https://racrproto.com/ns/jmap/messages';
  const session=await (await fetch(origin+'/api/jmap/session')).json();const accountId=session.primaryAccounts[capability];
  const call=async(name:string,args:unknown)=>{
    const result=await (await fetch(origin+'/api/jmap',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({using:['urn:ietf:params:jmap:core',capability],methodCalls:[[name,args,'test']]})})).json();
    if(result.methodResponses[0][0]!==name)throw Error('Fixture JMAP request failed');return result.methodResponses[0][1];
  };
  const query=await call('HailMessage/query',{accountId,filter:message});
  if(query.ids.length!==1)throw Error('Fixture message missing');const id=query.ids[0];
  const result=await call('HailMessage/set',{accountId,ifInState:query.queryState,...(patch?{update:{[id]:patch}}:{destroy:[id]})});
  if(patch?result.updated?.[id]!==null:!result.destroyed?.includes(id))throw Error('Fixture mutation failed');
}
