import type {SQL} from 'bun';
import type {AccountApiSession} from '../accounts/repository.js';
import {lockMessageAccount} from '../accounts/message-read.js';
import {JmapError,argumentsOnly,object,jmapAccountId,canMutateMessages,MAX_OBJECTS} from './common.js';
export const HAIL_ACCOUNT='https://racrproto.com/ns/jmap/account';
export const COLLECTIONS=['HailSent','HailSubmission','HailGrant','HailRelationship'] as const;
export type Collection=typeof COLLECTIONS[number];
const FIELDS:Record<Collection,readonly string[]>={
 HailSent:['id','sendId','kind','category','createdAt','bodyDigest','isInTrash','trashedAt','bodyBlobId'],
 HailSubmission:['id','sendId','kind','category','createdAt','bodyDigest','targets'],
 HailGrant:['id','grantId','localRole','grantor','grantee','revision','status','digest','cose'],
 HailRelationship:['id','kind','pairId','connectionId','peerDid','peerAddress','state','epoch','updatedAt','unseen','invitationId','personal','label','expiresAt','revokedAt','attemptId','direction','allowIntroductions','creatorDid','conversationId','leftAt']
};
const recordId=(id:string)=>'o_'+id.replaceAll('-','');
const uuid=(id:unknown)=>typeof id==='string'&&/^o_[0-9a-f]{32}$/.test(id)?`${id.slice(2,10)}-${id.slice(10,14)}-${id.slice(14,18)}-${id.slice(18,22)}-${id.slice(22)}`:null;
type Row={id:string;key:string;data:Record<string,unknown>};
export const canReadCollection=(s:AccountApiSession,c:Collection)=>s.scopes.includes(c==='HailGrant'?'grants:read':c==='HailRelationship'?'account:read':'messages:read');
export class JmapCollections {
 constructor(private readonly sql:SQL,private readonly origin:string){}
 accountId(s:AccountApiSession){return jmapAccountId(this.origin,s);}
 state(s:AccountApiSession,c:Collection,revision:string){return `${this.accountId(s)}_${c}_${revision}`;}
 private async snapshot<T>(s:AccountApiSession,c:Collection,work:(tx:SQL,state:string)=>Promise<T>){
  if(!canReadCollection(s,c))throw new JmapError('accountNotSupportedByMethod');
  return this.sql.begin(async tx=>{
   const row=(await tx`SELECT revision::text FROM jmap_collection_states WHERE account_id=${s.account_id} AND generation=${s.serving_generation??1} AND collection=${c} FOR SHARE`)[0];
   if(!row)throw new JmapError('accountNotFound');return work(tx as SQL,this.state(s,c,row.revision));
  });
 }
 currentState(s:AccountApiSession,c:Collection){return this.snapshot(s,c,async(_tx,state)=>state);}
 async get(s:AccountApiSession,c:Collection,args:Record<string,unknown>){
  argumentsOnly(args,['accountId','ids','properties']);const ids=args.ids??null,properties=args.properties??null;
  if(ids!==null&&(!Array.isArray(ids)||ids.some(id=>typeof id!=='string'||id.length>255))||properties!==null&&(!Array.isArray(properties)||properties.some(p=>typeof p!=='string'||!FIELDS[c].includes(p))))throw new JmapError('invalidArguments');
  if(Array.isArray(ids)&&ids.length>MAX_OBJECTS)throw new JmapError('requestTooLarge');
  return this.snapshot(s,c,async(tx,state)=>{
   const rows=await tx<Row[]>`SELECT id,key,data FROM jmap_objects WHERE account_id=${s.account_id} AND generation=${s.serving_generation??1} AND collection=${c}
    AND NOT destroyed AND (${ids===null} OR id IN(SELECT value::uuid FROM jsonb_array_elements_text(${JSON.stringify(ids===null?[]:(ids as string[]).map(uuid).filter(Boolean))}::text::jsonb))) ORDER BY id LIMIT ${MAX_OBJECTS+1}`;
   if(rows.length>MAX_OBJECTS)throw new JmapError('requestTooLarge');
   const list=rows.map(row=>{const data={...row.data,id:recordId(row.id),...(c==='HailSent'?{bodyBlobId:'s_'+row.id.replaceAll('-','')}: {})};return properties===null?data:Object.fromEntries(Object.entries(data).filter(([k])=>k==='id'||(properties as string[]).includes(k)));});
   if(Buffer.byteLength(JSON.stringify(list))>8*1024*1024)throw new JmapError('requestTooLarge');
   const found=new Set(rows.map(row=>recordId(row.id)));
   return {accountId:this.accountId(s),state,list,notFound:ids===null?[]:[...new Set(ids as string[])].filter(id=>!found.has(id))};
  });
 }
 async query(s:AccountApiSession,c:Collection,args:Record<string,unknown>){
  argumentsOnly(args,['accountId','filter','sort','position','limit','calculateTotal','anchor','anchorOffset']);
  const filter=args.filter??{},limit=args.limit??MAX_OBJECTS,position=args.position??0,sort=args.sort??[{property:'id',isAscending:true}];
  if(!object(filter)||Object.keys(filter).some(k=>!['kind','isInTrash','peerDid','status','grantor','grantee','sendId'].includes(k)))throw new JmapError('unsupportedFilter');
  if(Object.values(filter).some(v=>typeof v!=='string'&&typeof v!=='boolean')||!Number.isSafeInteger(limit)||Number(limit)<0||Number(limit)>MAX_OBJECTS||!Number.isSafeInteger(position))throw new JmapError('invalidArguments');
  if(!Array.isArray(sort)||sort.length!==1||!object(sort[0])||Object.keys(sort[0]).some(k=>!['property','isAscending'].includes(k))||sort[0].property!=='id'||sort[0].isAscending!==undefined&&sort[0].isAscending!==true)throw new JmapError('unsupportedSort');
  if(args.anchor!==undefined&&args.anchor!==null&&!uuid(args.anchor)||args.anchorOffset!==undefined&&!Number.isSafeInteger(args.anchorOffset))throw new JmapError('invalidArguments');
  if(args.calculateTotal!==undefined&&typeof args.calculateTotal!=='boolean')throw new JmapError('invalidArguments');
  return this.snapshot(s,c,async(tx,state)=>{
   const total=Number((await tx`SELECT count(*)::text AS n FROM jmap_objects WHERE account_id=${s.account_id} AND generation=${s.serving_generation??1} AND collection=${c} AND NOT destroyed
    AND data @> ${JSON.stringify(filter)}::text::jsonb`)[0]!.n);
   let start=Number(position);if(start<0)start=Math.max(0,total+start);
   if(args.anchor!=null){
    const anchor=uuid(args.anchor);
    if(!(await tx`SELECT 1 FROM jmap_objects WHERE id=${anchor}::uuid AND account_id=${s.account_id} AND generation=${s.serving_generation??1} AND collection=${c} AND NOT destroyed AND data @> ${JSON.stringify(filter)}::text::jsonb`).length)throw new JmapError('anchorNotFound');
    const index=Number((await tx`SELECT count(*)::text AS n FROM jmap_objects WHERE account_id=${s.account_id} AND generation=${s.serving_generation??1} AND collection=${c} AND NOT destroyed AND data @> ${JSON.stringify(filter)}::text::jsonb AND id<${anchor}::uuid`)[0]!.n);
    start=Math.max(0,index+Number(args.anchorOffset??0));
   }
   const page=await tx<{id:string}[]>`SELECT id FROM jmap_objects WHERE account_id=${s.account_id} AND generation=${s.serving_generation??1} AND collection=${c} AND NOT destroyed
    AND data @> ${JSON.stringify(filter)}::text::jsonb ORDER BY id LIMIT ${Number(limit)} OFFSET ${start}`;
   return {accountId:this.accountId(s),queryState:state,canCalculateChanges:false,position:start,ids:page.map(row=>recordId(row.id)),...(args.calculateTotal?{total}:{})};
  });
 }
 async changes(s:AccountApiSession,c:Collection,args:Record<string,unknown>){
  argumentsOnly(args,['accountId','sinceState','maxChanges']);if(!canReadCollection(s,c))throw new JmapError('accountNotSupportedByMethod');
  const prefix=this.state(s,c,''),max=args.maxChanges??MAX_OBJECTS;
  if(typeof args.sinceState!=='string'||!args.sinceState.startsWith(prefix)||! /^(0|[1-9][0-9]{0,18})$/.test(args.sinceState.slice(prefix.length)))throw new JmapError('cannotCalculateChanges');
  const since=BigInt(args.sinceState.slice(prefix.length));if(since>9223372036854775807n)throw new JmapError('cannotCalculateChanges');
  if(!Number.isSafeInteger(max)||Number(max)<1||Number(max)>MAX_OBJECTS)throw new JmapError('invalidArguments');
  const result=await this.sql.begin(async tx=>{
   const state=(await tx`SELECT revision::text,retained_from::text FROM jmap_collection_states WHERE account_id=${s.account_id} AND generation=${s.serving_generation??1} AND collection=${c} FOR UPDATE`)[0];
   if(!state)throw new JmapError('accountNotFound');
   const expired=await tx<{revision:string}[]>`DELETE FROM jmap_collection_changes WHERE account_id=${s.account_id} AND generation=${s.serving_generation??1} AND collection=${c}
    AND occurred_at<clock_timestamp()-interval '31 days' RETURNING revision::text`;
   let floor=BigInt(state.retained_from);for(const row of expired)if(BigInt(row.revision)>floor)floor=BigInt(row.revision);
   if(floor!==BigInt(state.retained_from))await tx`UPDATE jmap_collection_states SET retained_from=${floor.toString()} WHERE account_id=${s.account_id} AND generation=${s.serving_generation??1} AND collection=${c}`;
   if(since<floor||since>BigInt(state.revision))return null;
   const rows=await tx<{id:string;operation:string;revision:string}[]>`SELECT id,operation,revision::text FROM jmap_collection_changes WHERE account_id=${s.account_id}
    AND generation=${s.serving_generation??1} AND collection=${c} AND revision>${since.toString()}::bigint ORDER BY revision LIMIT ${Number(max)+1}`;
   const page=rows.slice(0,Number(max)),changes=new Map<string,{first:string;last:string}>();
   for(const row of page)changes.set(row.id,{first:changes.get(row.id)?.first??row.operation,last:row.operation});
   const created:string[]=[],updated:string[]=[],destroyed:string[]=[];
   for(const [id,change] of changes)if(change.first==='created'){if(change.last!=='destroyed')created.push(recordId(id));}else if(change.last==='destroyed')destroyed.push(recordId(id));else updated.push(recordId(id));
   return {accountId:this.accountId(s),oldState:args.sinceState,newState:this.state(s,c,rows.length>Number(max)?page.at(-1)!.revision:state.revision),hasMoreChanges:rows.length>Number(max),created,updated,destroyed};
  });
  if(result===null)throw new JmapError('cannotCalculateChanges');return result;
 }
 async blob(s:AccountApiSession,id:string){
  if(!s.scopes.includes('messages:read')||!/^s_[0-9a-f]{32}$/.test(id))return null;
  const row=(await this.sql<{body_bytes:Uint8Array}[]>`SELECT i.body_bytes FROM jmap_objects j JOIN account_sent_items i ON i.account_id=j.account_id AND i.kind||'/'||i.id::text=j.key
    WHERE j.id=${uuid('o_'+id.slice(2))}::uuid AND j.account_id=${s.account_id} AND j.generation=${s.serving_generation??1} AND j.collection='HailSent' AND NOT j.destroyed`)[0];
  return row?{bytes:row.body_bytes,type:'application/hail-body+cbor'}:null;
 }
 async setSent(s:AccountApiSession,args:Record<string,unknown>){
  argumentsOnly(args,['accountId','ifInState','ifTrashEnabled','create','update','destroy']);
  if(!canMutateMessages(s))throw new JmapError('forbidden');
  if(args.ifInState!=null&&typeof args.ifInState!=='string'||args.ifTrashEnabled!==undefined&&typeof args.ifTrashEnabled!=='boolean')throw new JmapError('invalidArguments');
  const update=args.update??{},destroy=args.destroy??[],create=args.create??{};
  if(!object(update)||!object(create)||!Array.isArray(destroy)||destroy.some(id=>typeof id!=='string')||Object.values(update).some(p=>!object(p)))throw new JmapError('invalidArguments');
  if(Object.keys(create).length+Object.keys(update).length+destroy.length>MAX_OBJECTS)throw new JmapError('requestTooLarge');
  return this.sql.begin(async tx=>{
   await lockMessageAccount(tx as SQL,s);await tx`SELECT hail_jmap_refresh(${s.account_id}::uuid)`;
   const revision=async()=>String((await tx`SELECT revision::text FROM jmap_collection_states WHERE account_id=${s.account_id} AND generation=${s.serving_generation??1} AND collection='HailSent' FOR UPDATE`)[0]!.revision);
   const oldState=this.state(s,'HailSent',await revision());if(args.ifInState!=null&&args.ifInState!==oldState)throw new JmapError('stateMismatch');
   const enabled=(await tx`SELECT trash_enabled FROM account_message_preferences WHERE account_id=${s.account_id}`)[0]?.trash_enabled!==false;
   if(args.ifTrashEnabled!==undefined&&args.ifTrashEnabled!==enabled)throw new JmapError('stateMismatch');
   const updated:Record<string,unknown>=Object.create(null),notUpdated:Record<string,unknown>=Object.create(null),notDestroyed:Record<string,unknown>=Object.create(null),destroyed:string[]=[];
   for(const id of new Set([...Object.keys(update),...destroy as string[]])){
    const row=(await tx<Row[]>`SELECT id,key,data FROM jmap_objects WHERE id=${uuid(id)}::uuid AND account_id=${s.account_id} AND generation=${s.serving_generation??1} AND collection='HailSent' AND NOT destroyed`)[0];
    const deleting=destroy.includes(id),errors=deleting?notDestroyed:notUpdated;
    if(!row){errors[id]={type:'notFound'};continue;}
    const [kind,sendId]=row.key.split('/'),patch=update[id] as Record<string,unknown>|undefined;
    if(deleting&&patch)notUpdated[id]={type:'willDestroy'};
    if(!deleting&&(Object.keys(patch!).some(k=>k!=='isInTrash')||typeof patch!.isInTrash!=='boolean')){errors[id]={type:'invalidProperties',properties:['isInTrash']};continue;}
    const trash=deleting?true:patch!.isInTrash;
    if(deleting&&enabled&&!row.data.isInTrash||!deleting&&trash&&!enabled){errors[id]={type:'forbidden'};continue;}
    if(!deleting&&trash===row.data.isInTrash){updated[id]=null;continue;}
    if(!trash){
     const rows=await tx`DELETE FROM account_sent_dispositions WHERE account_id=${s.account_id} AND kind=${kind!} AND send_id=${sendId!}::uuid AND NOT deleted AND trashed_at>clock_timestamp()-interval '30 days' RETURNING send_id`;
     if(!rows.length){errors[id]={type:'notFound'};continue;}
    }else{
     if((await tx`SELECT 1 FROM account_sent_members WHERE account_id=${s.account_id} AND kind=${kind!} AND send_id=${sendId!}::uuid AND completed IS NOT TRUE LIMIT 1`).length){errors[id]={type:'forbidden'};continue;}
     await tx`INSERT INTO account_sent_dispositions(account_id,kind,send_id,deleted) VALUES(${s.account_id},${kind!},${sendId!}::uuid,${deleting})
      ON CONFLICT(account_id,kind,send_id) DO UPDATE SET deleted=EXCLUDED.deleted OR account_sent_dispositions.deleted`;
    }
    if(deleting)destroyed.push(id);else updated[id]=null;
   }
   await tx`SELECT hail_jmap_refresh(${s.account_id}::uuid)`;
   const present=(o:Record<string,unknown>)=>Object.keys(o).length?o:null;
   return {accountId:this.accountId(s),oldState,newState:this.state(s,'HailSent',await revision()),created:null,updated:present(updated),destroyed:destroyed.length?destroyed:null,
    notCreated:present(Object.fromEntries(Object.keys(create).map(key=>[key,{type:'forbidden'}]))),notUpdated:present(notUpdated),notDestroyed:present(notDestroyed)};
  });
 }
}
