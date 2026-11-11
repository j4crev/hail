import {isDeepStrictEqual} from 'node:util';
import {draftIdPattern,parseDraftContent} from '@racrproto/client-support/drafts';
import {lockMessageAccount} from '../accounts/message-read.js';
import type {SQL} from 'bun';
import type {AccountApiSession} from '../accounts/repository.js';
import {JmapChangeLog} from './change-log.js';
import {JmapError,MAX_OBJECTS,argumentsOnly,object,canMutateMessages} from './common.js';
export const HAIL_DRAFTS='https://racrproto.com/ns/jmap/drafts';
export const MAX_DRAFT_GET_BYTES=2_097_152;
export const canReadDrafts=(session:AccountApiSession)=>session.scopes.includes('messages:read')&&!!session.passkey_credential_id;
const uuid=(id:unknown)=>typeof id==='string'&&/^d_[0-9a-f]{32}$/.test(id)?`${id.slice(2,10)}-${id.slice(10,14)}-${id.slice(14,18)}-${id.slice(18,22)}-${id.slice(22)}`:null;
const integer=(v:unknown,min:number,max:number)=>Number.isSafeInteger(v)&&Number(v)>=min&&Number(v)<=max;
const fields=['id','draftId','revision','content','updatedAt','isInTrash','trashedAt'];
interface Row {id:string;draft_id:string;revision:number;content:unknown;updated_at:Date;trashed_at:Date|null}
export class JmapDrafts {
  currentState(session:AccountApiSession){this.authorize(session);return this.log.snapshot(session,async(_tx,state)=>this.log.state(session,state.revision));}
  private readonly log:JmapChangeLog;
  constructor(private readonly sql:SQL,origin:string){this.log=new JmapChangeLog(sql,origin,'draft');}
  private authorize(session:AccountApiSession){if(!canReadDrafts(session))throw new JmapError('accountNotSupportedByMethod');}
  async get(session:AccountApiSession,args:Record<string,unknown>){
    this.authorize(session);argumentsOnly(args,['accountId','ids','properties']);
    const ids=args.ids??null,properties=args.properties??null;
    if(ids!==null&&(!Array.isArray(ids)||ids.some(id=>typeof id!=='string'||id.length>255))||
      properties!==null&&(!Array.isArray(properties)||properties.some(p=>!fields.includes(p))))throw new JmapError('invalidArguments');
    if(Array.isArray(ids)&&ids.length>MAX_OBJECTS)throw new JmapError('requestTooLarge');
    const requested=ids===null?null:[...new Set(ids as string[])],dbIds=requested?.map(uuid).filter((id):id is string=>id!==null)??[];
    const selected=properties===null?new Set(fields):new Set(['id',...properties as string[]]);
    return this.log.snapshot(session,async(tx,state)=>{
      // Check projected content size before materializing potentially many rich
      // drafts in the application. Clients may request fewer IDs or metadata only.
      const sizes=await tx<{id:string;bytes:number}[]>`SELECT j.id,CASE WHEN ${selected.has('content')} THEN octet_length(d.content::text) ELSE 0 END AS bytes
        FROM jmap_drafts j JOIN account_message_drafts d ON d.account_id=j.account_id AND d.id=j.draft_id
        WHERE j.account_id=${session.account_id} AND j.generation=${session.serving_generation??1} AND NOT j.destroyed
          AND (${requested===null} OR j.id IN (SELECT value::uuid FROM jsonb_array_elements_text(${JSON.stringify(dbIds)}::text::jsonb)))
        ORDER BY j.id LIMIT ${MAX_OBJECTS+1}`;
      if(sizes.length>MAX_OBJECTS||sizes.reduce((sum,r)=>sum+r.bytes+1024,0)>MAX_DRAFT_GET_BYTES)throw new JmapError('requestTooLarge');
      const rows=await tx<Row[]>`SELECT j.id,j.draft_id,d.revision,CASE WHEN ${selected.has('content')} THEN d.content ELSE NULL END AS content,d.updated_at,d.trashed_at
        FROM jmap_drafts j JOIN account_message_drafts d ON d.account_id=j.account_id AND d.id=j.draft_id
        WHERE j.id IN (SELECT value::uuid FROM jsonb_array_elements_text(${JSON.stringify(sizes.map(r=>r.id))}::text::jsonb))
          AND j.account_id=${session.account_id} AND j.generation=${session.serving_generation??1} AND NOT j.destroyed ORDER BY j.id`;
      const list=rows.map(row=>Object.fromEntries(Object.entries({id:this.log.recordId(row.id),draftId:row.draft_id,revision:row.revision,
        content:row.content,updatedAt:row.updated_at.toISOString(),isInTrash:row.trashed_at!==null,trashedAt:row.trashed_at?.toISOString()??null}).filter(([key])=>selected.has(key))));
      const found=new Set(rows.map(row=>this.log.recordId(row.id)));
      const result={accountId:this.log.accountId(session),state:this.log.state(session,state.revision),list,notFound:requested?.filter(id=>!found.has(id))??[]};
      if(Buffer.byteLength(JSON.stringify(result))>MAX_DRAFT_GET_BYTES)throw new JmapError('requestTooLarge');return result;
    });
  }
  async query(session:AccountApiSession,args:Record<string,unknown>){
    this.authorize(session);argumentsOnly(args,['accountId','filter','sort','position','anchor','anchorOffset','limit','calculateTotal']);
    const filter=args.filter??{},sort=args.sort??[{property:'updatedAt',isAscending:false}],limit=args.limit??MAX_OBJECTS;
    if(!object(filter)||!Array.isArray(sort)||!integer(limit,0,MAX_OBJECTS)||args.calculateTotal!==undefined&&typeof args.calculateTotal!=='boolean')throw new JmapError('invalidArguments');
    if(Object.keys(filter).some(k=>!['inTrash','draftId'].includes(k)))throw new JmapError('unsupportedFilter');
    if(filter.inTrash!==undefined&&typeof filter.inTrash!=='boolean'||filter.draftId!==undefined&&(typeof filter.draftId!=='string'||! /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(filter.draftId)))throw new JmapError('invalidArguments');
    if(sort.length!==1||!object(sort[0])||sort[0].property!=='updatedAt'||Object.keys(sort[0]).some(k=>!['property','isAscending'].includes(k))||
      sort[0].isAscending!==undefined&&typeof sort[0].isAscending!=='boolean')throw new JmapError('unsupportedSort');
    const asc=sort[0].isAscending??true,position=args.position??0,anchor=args.anchor??null,offset=args.anchorOffset??0;
    if(!integer(position,-Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER)||!integer(offset,-Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER)||anchor!==null&&typeof anchor!=='string')throw new JmapError('invalidArguments');
    return this.log.snapshot(session,async(tx,state)=>{
      const rows=await tx<{id:string|null;position:string|null;total:string}[]>`WITH matching AS (
        SELECT j.id,d.updated_at FROM jmap_drafts j JOIN account_message_drafts d ON d.account_id=j.account_id AND d.id=j.draft_id
        WHERE j.account_id=${session.account_id} AND j.generation=${session.serving_generation??1} AND NOT j.destroyed
          AND (${filter.inTrash??null}::boolean IS NULL OR (d.trashed_at IS NOT NULL)=${filter.inTrash??null})
          AND (${filter.draftId??null}::uuid IS NULL OR d.id=${filter.draftId??null}::uuid)
      ), ordered AS (
        SELECT id,row_number() OVER(ORDER BY CASE WHEN ${asc} THEN updated_at END ASC,CASE WHEN NOT ${asc} THEN updated_at END DESC,id)-1 AS n FROM matching
      ), bounds AS (
        SELECT count(*) AS total,CASE WHEN ${anchor}::text IS NOT NULL THEN (SELECT n FROM ordered WHERE id=${uuid(anchor)}::uuid)+${offset}::bigint
          WHEN ${position}::bigint<0 THEN count(*)+${position}::bigint ELSE ${position}::bigint END AS start FROM matching
      ) SELECT o.id,CASE WHEN b.start IS NULL THEN NULL ELSE GREATEST(0,b.start)::text END AS position,b.total::text
        FROM bounds b LEFT JOIN ordered o ON o.n>=GREATEST(0,b.start) AND o.n<GREATEST(0,b.start)+${limit}::bigint AND b.start IS NOT NULL ORDER BY o.n`;
      if(anchor!==null&&rows[0]?.position===null)throw new JmapError('anchorNotFound');
      return {accountId:this.log.accountId(session),queryState:this.log.state(session,state.revision),canCalculateChanges:false,
        position:Number(rows[0]?.position??0),ids:rows.filter(r=>r.id!==null).map(r=>this.log.recordId(r.id!)),
        ...(args.calculateTotal?{total:Number(rows[0]?.total??0)}:{}),limit};
    });
  }
  async set(session:AccountApiSession,args:Record<string,unknown>){
    argumentsOnly(args,['accountId','ifInState','ifTrashEnabled','create','update','destroy']);
    if(args.ifTrashEnabled!==undefined&&typeof args.ifTrashEnabled!=='boolean')throw new JmapError('invalidArguments');
    if(!canMutateMessages(session))throw new JmapError('forbidden');
    const create=args.create??{},update=args.update??{},destroy=args.destroy??[];
    if(args.ifInState!=null&&typeof args.ifInState!=='string'||!object(create)||!object(update)||!Array.isArray(destroy)||
      [...Object.keys(create),...Object.keys(update),...destroy].some(id=>typeof id!=='string'||! /^[A-Za-z0-9_-]{1,255}$/.test(id))||
      [...Object.values(create),...Object.values(update)].some(v=>!object(v)))throw new JmapError('invalidArguments');
    if(Object.keys(create).length+Object.keys(update).length+destroy.length>MAX_OBJECTS)throw new JmapError('requestTooLarge');
    return this.sql.begin(async tx=>{
      await lockMessageAccount(tx as SQL,session);
      const before=(await tx<{revision:string}[]>`SELECT revision::text FROM jmap_draft_states WHERE account_id=${session.account_id}
        AND generation=${session.serving_generation??1} FOR UPDATE`)[0];
      if(!before)throw new JmapError('accountNotFound');
      const oldState=this.log.state(session,before.revision);
      if(args.ifInState!=null&&args.ifInState!==oldState)throw new JmapError('stateMismatch');
      const trashEnabled=(await tx`SELECT trash_enabled FROM account_message_preferences WHERE account_id=${session.account_id}`)[0]?.trash_enabled!==false;
      if(args.ifTrashEnabled!==undefined&&args.ifTrashEnabled!==trashEnabled)throw new JmapError('stateMismatch');
      const created:Record<string,unknown>=Object.create(null),updated:Record<string,unknown>=Object.create(null),
        notCreated:Record<string,unknown>=Object.create(null),notUpdated:Record<string,unknown>=Object.create(null),notDestroyed:Record<string,unknown>=Object.create(null),destroyed:string[]=[];
      const validContent=(value:unknown)=>{try{parseDraftContent(value);return Buffer.byteLength(JSON.stringify(value))<=400000;}catch{return false;}};
      for(const [key,value] of Object.entries(create)){
        const data=value as Record<string,unknown>;
        if(Object.keys(data).some(k=>!['draftId','content'].includes(k))||typeof data.draftId!=='string'||!draftIdPattern.test(data.draftId)||!validContent(data.content)){
          notCreated[key]={type:'invalidProperties',properties:['draftId','content']};continue;
        }
        if(!(await tx`SELECT octet_length(${JSON.stringify(data.content)}::text::jsonb::text)<=400000 AS valid`)[0]?.valid){notCreated[key]={type:'invalidProperties',properties:['content']};continue;}
        const exists=await tx`SELECT 1 FROM account_message_drafts WHERE account_id=${session.account_id} AND id=${data.draftId}::uuid
          UNION ALL SELECT 1 FROM account_sent_items WHERE account_id=${session.account_id} AND id=${data.draftId}::uuid`;
        if(exists.length){notCreated[key]={type:'invalidProperties',properties:['draftId']};continue;}
        const saved=(await tx<{revision:number;updated_at:Date}[]>`INSERT INTO account_message_drafts(account_id,id,content)
          VALUES(${session.account_id},${data.draftId}::uuid,${JSON.stringify(data.content)}::text::jsonb) RETURNING revision,updated_at`)[0]!;
        const identity=(await tx<{id:string}[]>`SELECT id FROM jmap_drafts WHERE account_id=${session.account_id} AND generation=${session.serving_generation??1}
          AND draft_id=${data.draftId}::uuid AND NOT destroyed`)[0]!;
        created[key]={id:this.log.recordId(identity.id),revision:saved.revision,updatedAt:saved.updated_at.toISOString(),isInTrash:false,trashedAt:null};
      }
      for(const id of new Set([...Object.keys(update),...destroy as string[]])){
        const row=(await tx<Row[]>`SELECT j.id,j.draft_id,d.revision,d.content,d.updated_at,d.trashed_at FROM jmap_drafts j
          JOIN account_message_drafts d ON d.account_id=j.account_id AND d.id=j.draft_id WHERE j.id=${uuid(id)}::uuid
          AND j.account_id=${session.account_id} AND j.generation=${session.serving_generation??1} AND NOT j.destroyed`)[0];
        if(destroy.includes(id)){
          if(!row)notDestroyed[id]={type:'notFound'};
          else if(trashEnabled&&!row.trashed_at)notDestroyed[id]={type:'forbidden'};
          else {await tx`DELETE FROM account_message_drafts WHERE account_id=${session.account_id} AND id=${row.draft_id}`;destroyed.push(id);}
          if(Object.hasOwn(update,id))notUpdated[id]={type:row?'willDestroy':'notFound'};continue;
        }
        if(!row){notUpdated[id]={type:'notFound'};continue;}
        const patch=update[id] as Record<string,unknown>;
        const invalid=Object.keys(patch).filter(k=>k==='content'?!validContent(patch[k]):k==='isInTrash'?typeof patch[k]!=='boolean':true);
        if(Object.hasOwn(patch,'content')&&!invalid.includes('content')&&!(await tx`SELECT octet_length(${JSON.stringify(patch.content)}::text::jsonb::text)<=400000 AS valid`)[0]?.valid)invalid.push('content');
        if(invalid.length){notUpdated[id]={type:'invalidProperties',properties:invalid};continue;}
        if(patch.isInTrash===true&&!trashEnabled||Object.hasOwn(patch,'content')&&(patch.isInTrash??!!row.trashed_at)){
          notUpdated[id]={type:'forbidden'};continue;
        }
        if(row.trashed_at&&patch.isInTrash===false){
          const live=await tx`SELECT 1 FROM account_message_drafts WHERE account_id=${session.account_id} AND id=${row.draft_id}
            AND trashed_at>clock_timestamp()-interval '30 days'`;
          if(!trashEnabled||!live.length){notUpdated[id]={type:'notFound'};continue;}
        }
        const changed=Object.hasOwn(patch,'content')&&!isDeepStrictEqual(patch.content,row.content)||
          patch.isInTrash!==undefined&&patch.isInTrash!==!!row.trashed_at;
        if(!changed){updated[id]=null;continue;}
        const saved=(await tx<Row[]>`UPDATE account_message_drafts SET content=${JSON.stringify(patch.content??row.content)}::text::jsonb,
          trashed_at=CASE WHEN ${patch.isInTrash??!!row.trashed_at} THEN COALESCE(trashed_at,clock_timestamp()) ELSE NULL END,
          revision=revision+1,updated_at=clock_timestamp() WHERE account_id=${session.account_id} AND id=${row.draft_id} RETURNING *`)[0]!;
        updated[id]={revision:saved.revision,updatedAt:saved.updated_at.toISOString(),trashedAt:saved.trashed_at?.toISOString()??null};
      }
      const after=(await tx<{revision:string}[]>`SELECT revision::text FROM jmap_draft_states WHERE account_id=${session.account_id} AND generation=${session.serving_generation??1}`)[0]!;
      const nonempty=(value:Record<string,unknown>)=>Object.keys(value).length?value:null;
      return {accountId:this.log.accountId(session),oldState,newState:this.log.state(session,after.revision),created:nonempty(created),updated:nonempty(updated),
        destroyed:destroyed.length?destroyed:null,notCreated:nonempty(notCreated),notUpdated:nonempty(notUpdated),notDestroyed:nonempty(notDestroyed)};
    });
  }
  changes(session:AccountApiSession,args:Record<string,unknown>){this.authorize(session);return this.log.changes(session,args);}
}
