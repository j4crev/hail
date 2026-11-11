import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {SQL} from 'bun';
import {encodeDeterministic,inspectSignedPayload} from '@racrproto/codec';
import {BODY_CONTAINER_LIMITS,validateBodyBytes} from '../bodies/service.js';
import {bodyAttachments} from '../bodies/attachments.js';
export const SENT_TABLES=['account_publications','publication_targets','account_sent_dispositions'] as const;
type Row=Record<string,unknown>;
type Manifest={accountId:string;did:string;sourceGeneration?:number;tables:Record<string,Row[]>;connections?:{tables:Record<string,Row[]>};conversations?:{tables:Record<string,Row[]>}};
const id=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const time=(v:unknown)=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(v)&&Number.isFinite(Date.parse(v));
const integer=(v:unknown,min:number)=>Number.isSafeInteger(v)&&Number(v)>=min;
const bytes=(v:unknown)=>{if(typeof v!=='string'||!/^\\x(?:[0-9a-f]{2})+$/.test(v))throw Error('Invalid Sent history bytes');return Buffer.from(v.slice(2),'hex');};
const hex=(v:Uint8Array)=>'\\x'+Buffer.from(v).toString('hex');
function fields(row:Row,expected:string){if(Object.keys(row).sort().join(',')!==expected)throw Error('Invalid Sent history fields');}
/** Compare timestamp instants at database precision without rewriting signed input. */
export function sameSentRecord(a:Row|undefined,b:Row){
  if(!a)return false;
  const canonical=(row:Row)=>Object.fromEntries(Object.entries(row).map(([key,value])=>{
    if(['created_at','expires_at','cancelled_at','next_attempt_at','trashed_at'].includes(key)&&time(value)){
      const text=value as string,fraction=(text.match(/\.(\d+)(?:Z|[+-]\d\d:\d\d)$/)?.[1]??'').padEnd(6,'0');
      return [key,BigInt(Date.parse(text))*1000n+BigInt(fraction.slice(3))];
    }
    return [key,value];
  }));
  return isDeepStrictEqual(canonical(a),canonical(b));
}
export async function collectSentHistory(sql:SQL,account:string){
  return {
    account_publications:(await sql<{row:Row}[]>`SELECT to_jsonb(t) AS row FROM account_publications t WHERE account_id=${account} ORDER BY id`).map(r=>r.row),
    publication_targets:(await sql<{row:Row}[]>`SELECT to_jsonb(t) AS row FROM publication_targets t WHERE account_id=${account} ORDER BY publication_id,recipient_did`).map(r=>r.row),
    account_sent_dispositions:(await sql<{row:Row}[]>`SELECT to_jsonb(t) AS row FROM account_sent_dispositions t WHERE account_id=${account} ORDER BY kind,send_id`).map(r=>r.row),
  };
}
export function validateSentHistory(m:Manifest){
  const t=m.tables,pubs=new Map<string,Row>(),messages=new Set<string>(),audiences=new Set<string>();
  const batches=[...(m.connections?.tables.connection_message_batches??[]),...(m.conversations?.tables.connection_message_batches??[])];
  for(const row of t.account_publications!){
    fields(row,'account_id,body_bytes,cancelled_at,category,created_at,expires_at,id,reply_until,request_digest,sealed,sender_did,serving_generation');
    if(row.account_id!==m.accountId||row.sender_did!==m.did||!id(row.id)||pubs.has(String(row.id))||row.sealed!==true||
      !integer(row.serving_generation,1)||typeof row.category!=='string'||! /^[a-z0-9][a-z0-9._-]{0,63}$/.test(row.category)||
      !time(row.created_at)||!time(row.expires_at)||row.cancelled_at!==null&&!time(row.cancelled_at)||row.reply_until!==null&&!integer(row.reply_until,1))throw Error('Invalid retained publication');
    const body=bytes(row.body_bytes);validateBodyBytes(body);
    const digest=createHash('sha256').update(encodeDeterministic({category:row.category,body,allowReplies:row.reply_until!==null},BODY_CONTAINER_LIMITS)).digest();
    if(hex(digest)!==row.request_digest)throw Error('Publication intent digest differs');
    if(bodyAttachments(body).length&&!t.detached_bodies!.some(b=>b.digest===hex(createHash('sha256').update(body).digest())&&b.body_bytes===row.body_bytes))throw Error('Publication attachment body is missing');
    if(batches.some(b=>b.id===row.id)||t.account_message_drafts!.some(d=>d.id===row.id))throw Error('Publication identity conflicts with another logical send or draft');
    pubs.set(String(row.id),row);
  }
  for(const row of t.publication_targets!){
    fields(row,'account_id,attempts,grant_id,message_id,next_attempt_at,publication_id,recipient_did,state');
    const pub=pubs.get(String(row.publication_id)),key=String(row.publication_id)+'/'+String(row.recipient_did);
    const grant=t.grant_lineages!.find(g=>g.grant_id===row.grant_id);
    if(row.account_id!==m.accountId||!pub||!id(row.message_id)||!id(row.grant_id)||audiences.has(key)||messages.has(String(row.message_id))||
      !['submitted','blocked','cancelled','expired','indeterminate'].includes(String(row.state))||!integer(row.attempts,0)||!time(row.next_attempt_at)||
      !grant||grant.grantee_did!==m.did||grant.grantor_did!==row.recipient_did)throw Error('Unfinished, foreign or inconsistent publication target');
    audiences.add(key);messages.add(String(row.message_id));
    const envelope=t.sent_envelopes!.find(e=>e.message_id===row.message_id);
    if(row.state==='submitted'&&!envelope)throw Error('Submitted publication lost its envelope');
    if(envelope){
      const payload=inspectSignedPayload('hail.envelope',bytes(envelope.envelope_cose)).payload;
      if(envelope.sender_did!==m.did||envelope.recipient_did!==row.recipient_did||envelope.authorization_type!=='grant'||envelope.grant_id!==row.grant_id||
        payload.category!==pub.category||payload.reply.allowed!==(pub.reply_until!==null)||payload.reply.allowed&&payload.reply.until!==pub.reply_until||
        envelope.body_digest!==hex(createHash('sha256').update(bytes(pub.body_bytes)).digest()))throw Error('Publication target differs from its signed message');
    }
  }
  for(const pub of pubs.values()){
    const count=t.publication_targets!.filter(r=>r.publication_id===pub.id).length;
    if(count<1||count>100)throw Error('Publication has an incomplete audience');
  }
  const connectionMembers=[...(m.connections?.tables.connection_message_targets??[]),...(m.conversations?.tables.connection_message_targets??[])];
  const dispositions=new Set<string>();
  for(const row of t.account_sent_dispositions!){
    fields(row,'account_id,deleted,kind,send_id,trashed_at');
    const key=String(row.kind)+'/'+String(row.send_id);
    if(row.account_id!==m.accountId||!id(row.send_id)||typeof row.deleted!=='boolean'||!time(row.trashed_at)||dispositions.has(key))throw Error('Invalid Sent disposition');
    const exists=row.kind==='category'?pubs.has(String(row.send_id)):row.kind==='connections'?batches.some(b=>b.id===row.send_id):row.kind==='message'&&
      t.sent_envelopes!.some(e=>e.message_id===row.send_id)&&!messages.has(String(row.send_id))&&!connectionMembers.some(r=>r.message_id===row.send_id);
    if(!exists)throw Error('Sent disposition has no logical send');
    dispositions.add(key);
  }
}
/** Caller holds activation's account lock; input has passed the complete snapshot checks. */
export async function importSentHistory(sql:SQL,m:Manifest){
  for(const row of m.tables.account_publications!){
    const prior=(await sql<{row:Row}[]>`SELECT to_jsonb(p) AS row FROM account_publications p WHERE account_id=${m.accountId} AND id=${row.id}::uuid`)[0]?.row;
    if(prior){if(!sameSentRecord(prior,row))throw Error('Returning publication conflicts with immutable intent');continue;}
    await sql`INSERT INTO account_publications SELECT * FROM jsonb_populate_record(NULL::account_publications,${JSON.stringify({...row,sealed:false})}::text::jsonb)`;
    for(const target of m.tables.publication_targets!.filter(t=>t.publication_id===row.id))
      await sql`INSERT INTO publication_targets SELECT * FROM jsonb_populate_record(NULL::publication_targets,${JSON.stringify(target)}::text::jsonb)`;
    await sql`UPDATE account_publications SET sealed=true WHERE account_id=${m.accountId} AND id=${row.id}::uuid`;
  }
  // Existing parent rows are immutable and sealed, so never insert targets into
  // them speculatively. Compare the complete retained audience instead.
  for(const row of m.tables.publication_targets!){
    const prior=(await sql<{row:Row}[]>`SELECT to_jsonb(t) AS row FROM publication_targets t WHERE account_id=${m.accountId}
      AND publication_id=${row.publication_id}::uuid AND recipient_did=${row.recipient_did}`)[0]?.row;
    if(!sameSentRecord(prior,row))throw Error('Returning publication conflicts with retained audience');
  }
  await sql`DELETE FROM account_sent_dispositions WHERE account_id=${m.accountId}`;
  for(const row of m.tables.account_sent_dispositions!)await sql`INSERT INTO account_sent_dispositions SELECT *
    FROM jsonb_populate_record(NULL::account_sent_dispositions,${JSON.stringify(row)}::text::jsonb)`;
}
