import {createHash} from 'node:crypto';
import {parseDraftContent,type Draft} from '@racrproto/client-support/drafts';
export function jmapDraftFixture(drafts:Map<string,Draft>,trashEnabled:()=>boolean){
  const capability='https://racrproto.com/ns/jmap/drafts',accountId='fixture_account';
  const state=()=>createHash('sha256').update(JSON.stringify([...drafts])).digest('hex');
  const present=(d:Draft)=>({...d,id:'d_'+d.id.replaceAll('-',''),draftId:d.id,isInTrash:!!d.trashedAt});
  return {capability,accountId,call(name:string,args:Record<string,any>){
    if(args.accountId!==accountId)throw Error('accountNotFound');
    const rows=[...drafts.values()].map(present).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||a.id.localeCompare(b.id));
    if(name==='HailDraft/query'){
      const matched=rows.filter(d=>(args.filter?.draftId===undefined||d.draftId===args.filter.draftId)&&(args.filter?.inTrash===undefined||d.isInTrash===args.filter.inTrash));
      const position=args.anchor?matched.findIndex(d=>d.id===args.anchor)+(args.anchorOffset??0):0;
      if(position<0)throw Error('anchorNotFound');
      return {accountId,queryState:state(),canCalculateChanges:false,position,total:matched.length,ids:matched.slice(position,position+(args.limit??50)).map(d=>d.id)};
    }
    if(name==='HailDraft/get')return {accountId,state:state(),list:rows.filter(d=>!args.ids||args.ids.includes(d.id)),notFound:(args.ids??[]).filter((id:string)=>!rows.some(d=>d.id===id))};
    if(name!=='HailDraft/set')throw Error('unknownMethod');
    const oldState=state();if(args.ifInState!==oldState||args.ifTrashEnabled!==undefined&&args.ifTrashEnabled!==trashEnabled())throw Error('stateMismatch');
    const created:Record<string,unknown>={},updated:Record<string,unknown>={},notCreated:Record<string,unknown>={},notUpdated:Record<string,unknown>={},notDestroyed:Record<string,unknown>={},destroyed:string[]=[];
    for(const [key,value] of Object.entries(args.create??{}) as [string,any][]){
      if(drafts.has(value.draftId)){notCreated[key]={type:'invalidProperties'};continue;}
      const d:Draft={id:value.draftId,revision:1,content:parseDraftContent(value.content),updatedAt:new Date().toISOString(),trashedAt:null};drafts.set(d.id,d);created[key]=present(d);
    }
    for(const [id,patch] of Object.entries(args.update??{}) as [string,any][]){
      const row=rows.find(d=>d.id===id),d=row&&drafts.get(row.draftId);if(!d){notUpdated[id]={type:'notFound'};continue;}
      if(patch.content!==undefined)d.content=parseDraftContent(patch.content);
      if(patch.isInTrash!==undefined){if(!trashEnabled()){notUpdated[id]={type:'forbidden'};continue;}d.trashedAt=patch.isInTrash?d.trashedAt??new Date().toISOString():null;}
      d.revision++;d.updatedAt=new Date().toISOString();updated[id]={revision:d.revision,updatedAt:d.updatedAt,trashedAt:d.trashedAt};
    }
    for(const id of args.destroy??[]){const row=rows.find(d=>d.id===id);if(!row)notDestroyed[id]={type:'notFound'};else if(!row.isInTrash&&trashEnabled())notDestroyed[id]={type:'forbidden'};else{drafts.delete(row.draftId);destroyed.push(id);}}
    const filled=(o:Record<string,unknown>)=>Object.keys(o).length?o:null;
    return {accountId,oldState,newState:state(),created:filled(created),updated:filled(updated),notCreated:filled(notCreated),notUpdated:filled(notUpdated),notDestroyed:filled(notDestroyed),destroyed:destroyed.length?destroyed:null};
  }};
}
