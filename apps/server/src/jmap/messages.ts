import {MessageTrash} from '../accounts/message-trash.js';
import {lockMessageAccount,setReadInTransaction} from '../accounts/message-read.js';
import type {SQL} from 'bun';
import {encodeBase64Url} from '@racrproto/codec';
import type {AccountApiSession} from '../accounts/repository.js';

export {JMAP_CORE,HAIL_MESSAGES,MAX_OBJECTS,canMutateMessages,canDestroyMessages,JmapError,object,argumentsOnly} from './common.js';
import {MAX_OBJECTS,JmapError,object,argumentsOnly,canMutateMessages,canDestroyMessages} from './common.js';
import {JmapChangeLog} from './change-log.js';
const uuid=(id:unknown)=>typeof id==='string'&&/^m_[0-9a-f]{32}$/.test(id)?`${id.slice(2,10)}-${id.slice(10,14)}-${id.slice(14,18)}-${id.slice(18,22)}-${id.slice(22)}`:null;
const recordId=(id:string)=>`m_${id.replaceAll('-','')}`;
const integer=(v:unknown,min:number,max:number)=>Number.isSafeInteger(v)&&Number(v)>=min&&Number(v)<=max;
const date=(value:Date)=>value.toISOString().replace('.000Z','Z');
interface State {revision:string;retained_from:string}
interface MessageRow {id:string;sender_did:string;message_id:string;is_read:boolean;trashed_at:Date|null;delivered_at:Date;envelope_cose:Uint8Array}
export class JmapMessages {
  private readonly log:JmapChangeLog;
  constructor(private readonly sql:SQL,origin:string){this.log=new JmapChangeLog(sql,origin,'message');}
  currentState(session:AccountApiSession){return this.log.snapshot(session,async(_tx,state)=>this.log.state(session,state.revision));}
  accountId(session:AccountApiSession){return this.log.accountId(session);}
  private state(session:AccountApiSession,revision:string){return this.log.state(session,revision);}
  async get(session:AccountApiSession,args:Record<string,unknown>){
    argumentsOnly(args,['accountId','ids','properties']);
    const ids=args.ids??null,properties=args.properties??null;
    const fields=['id','sender','recipient','messageId','deliveredAt','isRead','isInTrash','trashedAt','bodyBlobId','envelopeBlobId','envelope'];
    if(ids!==null&&(!Array.isArray(ids)||ids.some(id=>typeof id!=='string'||id.length>255))||
      properties!==null&&(!Array.isArray(properties)||properties.some(p=>!fields.includes(p))))throw new JmapError('invalidArguments');
    if(Array.isArray(ids)&&ids.length>MAX_OBJECTS)throw new JmapError('requestTooLarge');
    const requested=ids===null?null:[...new Set(ids as string[])],dbIds=requested?.map(uuid).filter((id):id is string=>id!==null)??[];
    return this.log.snapshot(session,async(tx,state)=>{
      const rows=await tx<MessageRow[]>`SELECT j.id,m.sender_did,m.message_id,m.is_read,m.trashed_at,m.delivered_at,e.envelope_cose
        FROM jmap_messages j JOIN delivered_messages m ON m.recipient_did=${session.did} AND m.sender_did=j.sender_did AND m.message_id=j.message_id
        JOIN received_envelopes e ON e.sender_did=m.sender_did AND e.message_id=m.message_id AND e.recipient_did=m.recipient_did
        WHERE j.account_id=${session.account_id} AND j.generation=${session.serving_generation??1} AND NOT j.destroyed
          AND (${requested===null} OR j.id IN (SELECT value::uuid FROM jsonb_array_elements_text(${JSON.stringify(dbIds)}::text::jsonb)))
        ORDER BY j.id LIMIT ${MAX_OBJECTS+1}`;
      if(rows.length>MAX_OBJECTS)throw new JmapError('requestTooLarge');
      const selected=properties===null?new Set(fields):new Set(['id',...properties as string[]]);
      const list=rows.map(row=>{
        const id=recordId(row.id),item={id,sender:row.sender_did,recipient:session.did,messageId:row.message_id,
          deliveredAt:date(row.delivered_at),isRead:row.is_read,isInTrash:row.trashed_at!==null,trashedAt:row.trashed_at?date(row.trashed_at):null,
          bodyBlobId:`b_${id}`,envelopeBlobId:`e_${id}`,envelope:encodeBase64Url(row.envelope_cose)};
        return Object.fromEntries(Object.entries(item).filter(([key])=>selected.has(key)));
      });
      const found=new Set(rows.map(row=>recordId(row.id)));
      return {accountId:this.accountId(session),state:this.state(session,state.revision),list,notFound:requested?.filter(id=>!found.has(id))??[]};
    });
  }
  async query(session:AccountApiSession,args:Record<string,unknown>){
    argumentsOnly(args,['accountId','filter','sort','position','anchor','anchorOffset','limit','calculateTotal']);
    const filter=args.filter??{},sort=args.sort??[{property:'deliveredAt',isAscending:false}],limit=args.limit??MAX_OBJECTS;
    if(!object(filter)||!Array.isArray(sort)||!integer(limit,0,MAX_OBJECTS)||
      args.calculateTotal!==undefined&&typeof args.calculateTotal!=='boolean')throw new JmapError('invalidArguments');
    if(Object.keys(filter).some(k=>!['isRead','inTrash','sender','messageId'].includes(k)))throw new JmapError('unsupportedFilter');
    if(filter.isRead!==undefined&&typeof filter.isRead!=='boolean'||filter.inTrash!==undefined&&typeof filter.inTrash!=='boolean'||
      filter.sender!==undefined&&(typeof filter.sender!=='string'||!/^did:plc:[a-z2-7]{24}$/.test(filter.sender)))throw new JmapError('invalidArguments');
    if(filter.messageId!==undefined&&(typeof filter.messageId!=='string'||! /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(filter.messageId)))throw new JmapError('invalidArguments');
    if(sort.length!==1||!object(sort[0])||sort[0].property!=='deliveredAt'||Object.keys(sort[0]).some(k=>!['property','isAscending'].includes(k))||
      sort[0].isAscending!==undefined&&typeof sort[0].isAscending!=='boolean')throw new JmapError('unsupportedSort');
    const asc=sort[0].isAscending??true,position=args.position??0,anchor=args.anchor??null,offset=args.anchorOffset??0;
    if(!integer(position,-Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER)||!integer(offset,-Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER)||
      anchor!==null&&typeof anchor!=='string')throw new JmapError('invalidArguments');
    return this.log.snapshot(session,async(tx,state)=>{
      // Window ordinals give stable anchor/negative-position semantics; tie order
      // is the immutable provider-local record id, not a mutable cursor field.
      const rows=await tx<{id:string|null;position:string;total:string}[]>`
        WITH matching AS (
          SELECT j.id,m.delivered_at FROM jmap_messages j JOIN delivered_messages m
            ON m.recipient_did=${session.did} AND m.sender_did=j.sender_did AND m.message_id=j.message_id
          WHERE j.account_id=${session.account_id} AND j.generation=${session.serving_generation??1} AND NOT j.destroyed
            AND (${filter.isRead??null}::boolean IS NULL OR m.is_read=${filter.isRead??null})
            AND (${filter.inTrash??null}::boolean IS NULL OR (m.trashed_at IS NOT NULL)=${filter.inTrash??null})
            AND (${filter.sender??null}::text IS NULL OR m.sender_did=${filter.sender??null})
            AND (${filter.messageId??null}::uuid IS NULL OR m.message_id=${filter.messageId??null}::uuid)
        ), ordered AS (
          SELECT id,row_number() OVER(ORDER BY CASE WHEN ${asc} THEN delivered_at END ASC,
            CASE WHEN NOT ${asc} THEN delivered_at END DESC,id)-1 AS n FROM matching
        ), bounds AS (
          SELECT count(*) AS total, CASE WHEN ${anchor}::text IS NOT NULL THEN
            (SELECT n FROM ordered WHERE id=${uuid(anchor)}::uuid)+${offset}::bigint
            WHEN ${position}::bigint<0 THEN count(*)+${position}::bigint ELSE ${position}::bigint END AS start FROM matching
        ) SELECT o.id,GREATEST(0,b.start)::text AS position,b.total::text FROM bounds b LEFT JOIN ordered o
          ON o.n>=GREATEST(0,b.start) AND o.n<GREATEST(0,b.start)+${limit}::bigint
          AND b.start IS NOT NULL ORDER BY o.n`;
      if(anchor!==null&&rows[0]?.position===null)throw new JmapError('anchorNotFound');
      // PostgreSQL GREATEST ignores NULL: explicitly validate anchor membership.
      if(anchor!==null){
        const exists=await tx`SELECT 1 FROM jmap_messages j JOIN delivered_messages m ON m.recipient_did=${session.did}
          AND m.sender_did=j.sender_did AND m.message_id=j.message_id WHERE j.id=${uuid(anchor)}::uuid
          AND j.account_id=${session.account_id} AND j.generation=${session.serving_generation??1} AND NOT j.destroyed
          AND (${filter.isRead??null}::boolean IS NULL OR m.is_read=${filter.isRead??null})
          AND (${filter.inTrash??null}::boolean IS NULL OR (m.trashed_at IS NOT NULL)=${filter.inTrash??null})
          AND (${filter.sender??null}::text IS NULL OR m.sender_did=${filter.sender??null})
            AND (${filter.messageId??null}::uuid IS NULL OR m.message_id=${filter.messageId??null}::uuid)`;
        if(!exists.length)throw new JmapError('anchorNotFound');
      }
      return {accountId:this.accountId(session),queryState:this.state(session,state.revision),canCalculateChanges:false,
        position:Number(rows[0]?.position??0),ids:rows.filter(r=>r.id!==null).map(r=>recordId(r.id!)),
        ...(args.calculateTotal?{total:Number(rows[0]?.total??0)}:{}),limit};
    });
  }
  changes(session:AccountApiSession,args:Record<string,unknown>){return this.log.changes(session,args);}
  async set(session:AccountApiSession,args:Record<string,unknown>){
    argumentsOnly(args,['accountId','ifInState','ifTrashEnabled','create','update','destroy']);
    const create=args.create??{},update=args.update??{},destroy=args.destroy??[];
    if(args.ifTrashEnabled!==undefined&&typeof args.ifTrashEnabled!=='boolean')throw new JmapError('invalidArguments');
    if(args.ifInState!=null&&typeof args.ifInState!=='string'||!object(create)||!object(update)||!Array.isArray(destroy)||
      Object.keys(create).some(id=>! /^[A-Za-z0-9_-]{1,255}$/.test(id))||Object.values(create).some(v=>!object(v))||
      Object.keys(update).some(id=>! /^[A-Za-z0-9_-]{1,255}$/.test(id))||Object.values(update).some(v=>!object(v))||
      destroy.some(id=>typeof id!=='string'||! /^[A-Za-z0-9_-]{1,255}$/.test(id)))throw new JmapError('invalidArguments');
    if(Object.keys(create).length+Object.keys(update).length+destroy.length>MAX_OBJECTS)throw new JmapError('requestTooLarge');
    // Bearer tokens retain the existing CLI permanent-delete authority only.
    if(!canDestroyMessages(session)||!canMutateMessages(session)&&(Object.keys(create).length||Object.keys(update).length))throw new JmapError('forbidden');
    return this.sql.begin(async tx=>{
      await lockMessageAccount(tx as SQL,session);
      const before=(await tx<State[]>`SELECT revision::text,retained_from::text FROM jmap_message_states
        WHERE account_id=${session.account_id} AND generation=${session.serving_generation??1} FOR UPDATE`)[0];
      if(!before)throw new JmapError('accountNotFound');
      const oldState=this.state(session,before.revision);
      if(args.ifInState!=null&&args.ifInState!==oldState)throw new JmapError('stateMismatch');
      const updated:Record<string,unknown>=Object.create(null),notUpdated:Record<string,unknown>=Object.create(null);
      const notCreated=Object.fromEntries(Object.keys(create).map(id=>[id,{type:'forbidden'}]));
      const notDestroyed:Record<string,unknown>=Object.create(null),destroyed:string[]=[];
      const trash=new MessageTrash(tx as SQL),settings=await trash.settings(session);
      if(args.ifTrashEnabled!==undefined&&args.ifTrashEnabled!==settings.trashEnabled)throw new JmapError('stateMismatch');
      for(const id of [...new Set([...Object.keys(update),...destroy as string[]])]){
        const row=(await tx<MessageRow[]>`SELECT j.id,m.sender_did,m.message_id,m.is_read,m.trashed_at,m.delivered_at,e.envelope_cose
          FROM jmap_messages j JOIN delivered_messages m ON m.recipient_did=${session.did} AND m.sender_did=j.sender_did AND m.message_id=j.message_id
          JOIN received_envelopes e ON e.sender_did=m.sender_did AND e.message_id=m.message_id AND e.recipient_did=m.recipient_did
          WHERE j.id=${uuid(id)}::uuid AND j.account_id=${session.account_id} AND j.generation=${session.serving_generation??1} AND NOT j.destroyed`)[0];
        if(destroy.includes(id)){
          if(!row)notDestroyed[id]={type:'notFound'};
          else if(session.passkey_credential_id&&settings.trashEnabled&&!row.trashed_at)notDestroyed[id]={type:'forbidden'};
          else {await trash.removeInTransaction(tx as SQL,session,row.sender_did,row.message_id,true);destroyed.push(id);}
          if(Object.hasOwn(update,id))notUpdated[id]={type:row?'willDestroy':'notFound'};
          continue;
        }
        if(!Object.hasOwn(update,id))continue;
        if(!row){notUpdated[id]={type:'notFound'};continue;}
        const patch=update[id] as Record<string,unknown>;
        const current:Record<string,unknown>={id,sender:row.sender_did,recipient:session.did,messageId:row.message_id,
          deliveredAt:date(row.delivered_at),isRead:row.is_read,isInTrash:row.trashed_at!==null,trashedAt:row.trashed_at?date(row.trashed_at):null,bodyBlobId:`b_${id}`,envelopeBlobId:`e_${id}`,envelope:encodeBase64Url(row.envelope_cose)};
        const invalid=Object.keys(patch).filter(key=>['isRead','isInTrash'].includes(key)?typeof patch[key]!=='boolean':!Object.hasOwn(current,key)||patch[key]!==current[key]);
        if(invalid.length){notUpdated[id]={type:'invalidProperties',properties:invalid};continue;}
        const targetTrash=patch.isInTrash??(row.trashed_at!==null);
        if(targetTrash===true&&(!settings.trashEnabled||Object.hasOwn(patch,'isRead'))){notUpdated[id]={type:'forbidden'};continue;}
        let computed:Record<string,unknown>|null=null;
        if(patch.isInTrash===false&&row.trashed_at){
          if(!settings.trashEnabled||!await trash.restoreInTransaction(tx as SQL,session,row.sender_did,row.message_id)){
            notUpdated[id]={type:'notFound'};continue;
          }
          computed={trashedAt:null};
        }else if(patch.isInTrash===true&&!row.trashed_at){
          await trash.removeInTransaction(tx as SQL,session,row.sender_did,row.message_id);
          const saved=(await tx<{trashed_at:Date}[]>`SELECT trashed_at FROM delivered_messages WHERE recipient_did=${session.did}
            AND sender_did=${row.sender_did} AND message_id=${row.message_id}`)[0]!;
          computed={trashedAt:date(saved.trashed_at)};
        }
        if(Object.hasOwn(patch,'isRead')){
          const result=await setReadInTransaction(tx as SQL,session,row.sender_did,row.message_id,patch.isRead as boolean);
          if(!result){notUpdated[id]={type:'notFound'};continue;}
        }
        updated[id]=computed;
      }
      const after=(await tx<{revision:string}[]>`SELECT revision::text FROM jmap_message_states
        WHERE account_id=${session.account_id} AND generation=${session.serving_generation??1}`)[0]!;
      const nonempty=(value:Record<string,unknown>)=>Object.keys(value).length?value:null;
      return {accountId:this.accountId(session),oldState,newState:this.state(session,after.revision),created:null,
        updated:nonempty(updated),destroyed:destroyed.length?destroyed:null,notCreated:nonempty(notCreated),notUpdated:nonempty(notUpdated),notDestroyed:nonempty(notDestroyed)};
    });
  }
  async blob(session:AccountApiSession,id:string){
    const match=/^([be])_(m_[0-9a-f]{32})$/.exec(id);if(!match)return null;
    const rows=await this.sql<{envelope_cose:Uint8Array;body_bytes:Uint8Array}[]>`
      SELECT e.envelope_cose,b.body_bytes FROM jmap_messages j JOIN delivered_messages m
        ON m.recipient_did=${session.did} AND m.sender_did=j.sender_did AND m.message_id=j.message_id
      JOIN received_envelopes e ON e.sender_did=m.sender_did AND e.message_id=m.message_id AND e.recipient_did=m.recipient_did
      JOIN verified_body_contents b ON b.recipient_did=m.recipient_did AND b.sender_did=m.sender_did
        AND b.digest=m.body_digest AND b.media_type=m.media_type AND b.profile=m.profile
      WHERE j.id=${uuid(match[2])}::uuid AND j.account_id=${session.account_id}
        AND j.generation=${session.serving_generation??1} AND NOT j.destroyed`;
    if(!rows[0])return null;
    return match[1]==='e'?{bytes:rows[0].envelope_cose,type:'application/cose; cose-type="cose-sign1"'}:
      {bytes:rows[0].body_bytes,type:'application/hail-body+cbor'};
  }
}
