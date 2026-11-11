import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {encodeDeterministic,signPayload,createWebCryptoSigner} from '@racrproto/codec';
import {bodyFromText} from '../src/bodies/service.js';
import {validateSentHistory,sameSentRecord} from '../src/migration/sent-history.js';
const account='00000000-0000-4000-8000-000000000001',did='did:plc:'+'a'.repeat(24),peer='did:plc:'+'b'.repeat(24);
const id='019a0000-0000-7000-8000-000000000001',message='019a0000-0000-7000-8000-000000000002',grant='019a0000-0000-7000-8000-000000000003';
const date='2026-11-01T12:00:00Z',hex=(b:Uint8Array)=>'\\x'+Buffer.from(b).toString('hex'),hash=(b:Uint8Array)=>createHash('sha256').update(b).digest();
const body=bodyFromText('Retained category send');
const keys=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']);
const signed=await signPayload('hail.envelope',{type:'hail.envelope',version:1,message_id:message,from:did,to:peer,
  authorization:{type:'grant',grant_id:grant},category:'updates',created_at:1793534400,expires_at:1793538000,
  body:{digest:{algorithm:'sha-256',value:hash(body)},size:body.length,media_type:'application/hail-body+cbor',profile:'spt-1',available_until:1796212800,
    access:{type:'bearer',token:new Uint8Array(32),expires_at:1796212800}},reply:{allowed:false}},createWebCryptoSigner(did+'#hail-messaging',keys.privateKey));
function fixture(){const body=bodyFromText('Retained category send');return {accountId:account,did,sourceGeneration:2,tables:{
  account_publications:[{account_id:account,id,sender_did:did,serving_generation:1,category:'updates',body_bytes:hex(body),
    request_digest:hex(hash(encodeDeterministic({category:'updates',body,allowReplies:false}))),reply_until:null,created_at:date,expires_at:date,cancelled_at:null,sealed:true}],
  publication_targets:[{account_id:account,publication_id:id,grant_id:grant,recipient_did:peer,message_id:message,state:'submitted',attempts:1,next_attempt_at:date}],
  account_sent_dispositions:[{account_id:account,kind:'category',send_id:id,trashed_at:date,deleted:true}],
  grant_lineages:[{grant_id:grant,grantor_did:peer,grantee_did:did}],
  sent_envelopes:[{sender_did:did,recipient_did:peer,message_id:message,authorization_type:'grant',grant_id:grant,envelope_cose:hex(signed),body_digest:hex(hash(body))}],
  detached_bodies:[],account_message_drafts:[] as Record<string,unknown>[],
},connections:{tables:{connection_message_batches:[] as Record<string,unknown>[],connection_message_targets:[] as Record<string,unknown>[]}}};}
it('preserves terminal audiences, source generation and exact deletion timestamps',()=>{const m=fixture(),before=JSON.stringify(m);validateSentHistory(m);expect(JSON.stringify(m)).toBe(before);});
for(const [name,mutate] of Object.entries({
  pending:(m:ReturnType<typeof fixture>)=>{m.tables.publication_targets[0]!.state='pending';},
  unsealed:(m:ReturnType<typeof fixture>)=>{m.tables.account_publications[0]!.sealed=false;},
  foreignOwner:(m:ReturnType<typeof fixture>)=>{m.tables.account_publications[0]!.account_id='foreign';},
  invalidGeneration:(m:ReturnType<typeof fixture>)=>{m.tables.account_publications[0]!.serving_generation=0;},
  changedIntent:(m:ReturnType<typeof fixture>)=>{m.tables.account_publications[0]!.category='other';},
  missingAudience:(m:ReturnType<typeof fixture>)=>{m.tables.publication_targets=[];},
  duplicateRecipient:(m:ReturnType<typeof fixture>)=>{m.tables.publication_targets.push({...m.tables.publication_targets[0]!});},
  wrongGrant:(m:ReturnType<typeof fixture>)=>{m.tables.grant_lineages[0]!.grantor_did=did;},
  missingEnvelope:(m:ReturnType<typeof fixture>)=>{m.tables.sent_envelopes=[];},
  changedEnvelope:(m:ReturnType<typeof fixture>)=>{m.tables.sent_envelopes[0]!.body_digest='\\x'+'00'.repeat(32);},
  invalidTrash:(m:ReturnType<typeof fixture>)=>{m.tables.account_sent_dispositions[0]!.trashed_at='today';},
  orphanTrash:(m:ReturnType<typeof fixture>)=>{m.tables.account_sent_dispositions[0]!.send_id=message;},
  hiddenMember:(m:ReturnType<typeof fixture>)=>{m.tables.account_sent_dispositions[0]!.kind='message';m.tables.account_sent_dispositions[0]!.send_id=message;},
  draftCollision:(m:ReturnType<typeof fixture>)=>{m.tables.account_message_drafts.push({id});},
  batchCollision:(m:ReturnType<typeof fixture>)=>{m.connections.tables.connection_message_batches.push({id});},
}))it('rejects Sent history '+name,()=>{const m=fixture();mutate(m);expect(()=>validateSentHistory(m)).toThrow();});
it('retains cancelled targets that never produced an envelope',()=>{const m=fixture();m.tables.publication_targets[0]!.state='cancelled';m.tables.sent_envelopes=[];validateSentHistory(m);});

it('does not compare retained source generations to a different provider epoch',()=>{const m=fixture();m.tables.account_publications[0]!.serving_generation=7;validateSentHistory(m);});

it('compares imported timestamps without losing microseconds or requiring a timezone spelling',()=>{
  const a={trashed_at:'2026-11-01T12:00:00.123456+00:00',deleted:true};
  expect(sameSentRecord(a,{...a,trashed_at:'2026-11-01T07:00:00.123456-05:00'})).toBe(true);
  expect(sameSentRecord(a,{...a,trashed_at:'2026-11-01T12:00:00.123457Z'})).toBe(false);
  expect(sameSentRecord(a,{...a,deleted:false})).toBe(false);
});
