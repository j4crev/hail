import Ajv from 'ajv';
import schema from '../../../spec/schemas/jmap-account-object-v1.json';
import {randomBytes,randomUUID} from 'node:crypto';
import {SQL} from 'bun';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {ProviderDatabase} from '../src/db/database.js';
import type {AccountApiSession} from '../src/accounts/repository.js';
import {JmapCollections} from '../src/jmap/collections.js';
import {uuidV7} from '../src/identity/uuid-v7.js';
const integration=process.env.DATABASE_URL?describe:describe.skip;
const freshDid=()=>`did:plc:${Array.from(randomBytes(24),b=>'abcdefghijklmnopqrstuvwxyz234567'[b%32]).join('')}`;
integration('JMAP Grant and relationship domain projections',()=>{
 let admin:SQL,db:ProviderDatabase,namespace:string,jmap:JmapCollections;
 const validate=new Ajv().compile(schema);
 beforeAll(async()=>{
  admin=new SQL(process.env.DATABASE_URL!);namespace='jmap_relationships_'+randomUUID().replaceAll('-','');
  await admin.unsafe(`CREATE SCHEMA "${namespace}"`);
  const url=new URL(process.env.DATABASE_URL!);url.searchParams.set('options',`-csearch_path=${namespace}`);
  db=new ProviderDatabase(url.toString());await db.migrate();jmap=new JmapCollections(db.sql,'https://jmap.example.com');
 });
 afterAll(async()=>{if(db)await db.close();if(admin){if(namespace)await admin.unsafe(`DROP SCHEMA "${namespace}" CASCADE`);await admin.close();}});
 async function account():Promise<AccountApiSession>{
  const id=randomUUID(),did=freshDid(),address=id+'@jmap.example.com';
  await db.sql`INSERT INTO provider_accounts(id,tenant_id,canonical_address,did,onboarding_state,activated_at,activation_binding_digest,activation_verification_mode)
   VALUES(${id},${randomUUID()},${address},${did},'active',now(),${randomBytes(32)},'public')`;
  return {account_id:id,credential_id:randomUUID(),credential_expires_at:new Date(Date.now()+60000),did,canonical_address:address,
   scopes:['account:read','grants:read'],migration_state:null,serving_generation:1};
 }
 async function snapshot(s:AccountApiSession,type:'HailGrant'|'HailRelationship'){
  const result=await jmap.get(s,type,{});
  for(const row of result.list)expect(validate(row),JSON.stringify(validate.errors)).toBe(true);
  return {...result,list:result.list as (Record<string,unknown>&{id:string})[]};
 }
 // Synthetic signed bytes exercise carriage, not cryptographic ingestion; all
 // original domain constraints and mutation triggers remain enabled.
 it('tracks current signed Grant revisions for grantor and collocated receiver only',async()=>{
  const owner=await account(),receiver=await account(),stranger=await account(),grantId=uuidV7(),digest=randomBytes(32),cose=randomBytes(80);
  const ownerEmpty=await snapshot(owner,'HailGrant'),receiverEmpty=await snapshot(receiver,'HailGrant');
  await db.sql.begin(async tx=>{
   await tx`INSERT INTO grant_lineages(grant_id,local_account_id,local_role,grantor_did,grantee_did,current_revision,current_digest,current_status)
    VALUES(${grantId},${owner.account_id},'grantor',${owner.did},${receiver.did},1,${digest},'active')`;
   await tx`INSERT INTO grant_revisions(grant_id,revision,status,issued_at,updated_at,scope_payload,consent_address_binding_sha256,consent_sender_profile_sha256,cose,representation_digest,signing_public_key,signing_plc_document,signing_plc_data,signing_plc_operation_log)
    VALUES(${grantId},1,'active',1,1,'[{"type":"categories","values":["updates"]}]',${digest},${digest},${cose},${digest},'fixture','{}','{}','[]')`;
  });
  const own=await snapshot(owner,'HailGrant');expect(own.list).toHaveLength(1);expect(own.list[0]).toMatchObject({grantId,localRole:'grantor',revision:1,cose:cose.toString('base64url'),digest:digest.toString('base64url')});
  expect((await snapshot(receiver,'HailGrant')).list).toEqual([]);
  await db.sql`INSERT INTO collocated_grant_receivers(grant_id,grantee_account_id) VALUES(${grantId},${receiver.account_id})`;
  const received=await snapshot(receiver,'HailGrant');expect(received.list).toHaveLength(1);expect(received.list[0]).toMatchObject({grantId,localRole:'grantee',cose:cose.toString('base64url')});
  expect(received.list[0]!.id).not.toBe(own.list[0]!.id);
  expect(await jmap.changes(owner,'HailGrant',{sinceState:ownerEmpty.state})).toMatchObject({created:[own.list[0]!.id],updated:[],destroyed:[]});
  expect(await jmap.changes(receiver,'HailGrant',{sinceState:receiverEmpty.state})).toMatchObject({created:[received.list[0]!.id],updated:[],destroyed:[]});
  expect((await snapshot(stranger,'HailGrant')).list).toEqual([]);
  expect((await jmap.get(receiver,'HailGrant',{ids:[own.list[0]!.id]})).notFound).toEqual([own.list[0]!.id]);
  const nextDigest=randomBytes(32),revoked=randomBytes(90);
  await db.sql.begin(async tx=>{
   await tx`INSERT INTO grant_revisions(grant_id,revision,status,issued_at,updated_at,previous_digest,scope_payload,consent_address_binding_sha256,consent_sender_profile_sha256,cose,representation_digest,signing_public_key,signing_plc_document,signing_plc_data,signing_plc_operation_log)
    VALUES(${grantId},2,'revoked',1,2,${digest},'[]',${digest},${digest},${revoked},${nextDigest},'fixture','{}','{}','[]')`;
   await tx`UPDATE grant_lineages SET current_revision=2,current_digest=${nextDigest},current_status='revoked' WHERE grant_id=${grantId}`;
  });
  for(const [session,before] of [[owner,own],[receiver,received]] as const){
   const after=await snapshot(session,'HailGrant');expect(after.list[0]).toMatchObject({id:before.list[0]!.id,revision:2,status:'revoked',cose:revoked.toString('base64url')});
   expect(await jmap.changes(session,'HailGrant',{sinceState:before.state})).toMatchObject({created:[],updated:[before.list[0]!.id],destroyed:[]});
  }
  const stable=await snapshot(owner,'HailGrant');await db.sql`UPDATE grant_lineages SET current_status=current_status WHERE grant_id=${grantId}`;
  expect(await snapshot(owner,'HailGrant')).toEqual(stable);
  await expect(jmap.get({...owner,scopes:['account:read']},'HailGrant',{})).rejects.toMatchObject({type:'accountNotSupportedByMethod'});
 });
 it('tracks connection state, unseen markers and private invitation/attempt metadata without secrets',async()=>{
  const owner=await account(),other=await account(),pairId=randomUUID(),connectionId=uuidV7(),invitationId=randomUUID(),attemptId=randomUUID(),secret=randomBytes(48),proof=randomBytes(80);
  const empty=await snapshot(owner,'HailRelationship');
  await db.sql`INSERT INTO federated_connection_pairs(id,account_id,serving_generation,local_did,peer_did,peer_address,peer_service_base,coordinator_service_base,epoch,state,connection_id)
   VALUES(${pairId},${owner.account_id},1,${owner.did},${other.did},${other.canonical_address},'https://peer.example/hail','https://peer.example/hail',1,'active',${connectionId})`;
  const paired=await snapshot(owner,'HailRelationship'),pair=paired.list[0]!;expect(pair).toMatchObject({kind:'connection',pairId,connectionId,unseen:false});
  await db.sql`INSERT INTO connection_unseen(account_id,pair_id,serving_generation,connection_id,epoch) VALUES(${owner.account_id},${pairId},1,${connectionId},1)`;
  const unseen=await snapshot(owner,'HailRelationship');expect(unseen.list[0]).toMatchObject({id:pair.id,unseen:true});
  expect(await jmap.changes(owner,'HailRelationship',{sinceState:paired.state})).toMatchObject({updated:[pair.id]});
  await db.sql`UPDATE connection_unseen SET seen_at=clock_timestamp() WHERE account_id=${owner.account_id}`;
  await db.sql`INSERT INTO connection_invitations(id,account_id,serving_generation,did,personal,label,request_id,request_digest,token_hash,ciphertext,nonce,cose,signing_key,signing_evidence,expires_at)
   VALUES(${invitationId},${owner.account_id},1,${owner.did},false,'Fixture invitation',${randomUUID()},${randomBytes(32)},${randomBytes(32)},${secret},${randomBytes(12)},${proof},'secret-signing-key','{"private":"secret-evidence"}',2000000000)`;
  await db.sql`INSERT INTO federated_connection_attempts(id,account_id,pair_id,direction,bundle,proof_digest,token_ciphertext,token_nonce,state,expires_at)
   VALUES(${attemptId},${owner.account_id},${pairId},'outbound',${proof},${randomBytes(32)},${secret},${randomBytes(12)},'pending',clock_timestamp()+interval '1 hour')`;
  const loaded=await snapshot(owner,'HailRelationship');expect(loaded.list).toHaveLength(3);
  expect(loaded.list.find(row=>row.kind==='connection')).toMatchObject({unseen:false});
  expect(loaded.list.find(row=>row.kind==='invitation')).toMatchObject({invitationId,expiresAt:2000000000,revokedAt:null});
  expect(loaded.list.find(row=>row.kind==='attempt')).toMatchObject({attemptId,state:'pending'});
  const encoded=JSON.stringify(loaded.list);for(const value of [secret.toString('base64url'),proof.toString('base64url'),'secret-evidence','secret-signing-key','token_hash','ciphertext','signing_evidence','bundle'])expect(encoded).not.toContain(value);
  expect((await snapshot(other,'HailRelationship')).list).toEqual([]);
  expect((await jmap.changes(owner,'HailRelationship',{sinceState:empty.state})).created.sort()).toEqual(loaded.list.map(row=>row.id).sort());
  await db.sql`UPDATE federated_connection_attempts SET attempts=attempts+1,next_attempt_at=clock_timestamp() WHERE account_id=${owner.account_id}`;
  expect(await snapshot(owner,'HailRelationship')).toEqual(loaded); // Retry bookkeeping is not projected metadata.
  await db.sql`UPDATE connection_invitations SET revoked_at=clock_timestamp() WHERE id=${invitationId}`;
  await db.sql`UPDATE federated_connection_attempts SET state='expired' WHERE id=${attemptId}`;
  await db.sql`UPDATE federated_connection_pairs SET state='disconnected',updated_at=clock_timestamp() WHERE id=${pairId}`;
  const updated=await snapshot(owner,'HailRelationship');expect(updated.list.find(row=>row.kind==='attempt')).toMatchObject({state:'expired'});
  expect(updated.list.find(row=>row.kind==='invitation')!.revokedAt).not.toBeNull();
  expect(updated.list.find(row=>row.kind==='connection')).toMatchObject({state:'disconnected'});
  expect((await jmap.changes(owner,'HailRelationship',{sinceState:loaded.state})).updated.sort()).toEqual(loaded.list.map(row=>row.id).sort());
 });
 it('tracks account/connection preferences and conversation membership, with stable reads and no-op updates',async()=>{
  const owner=await account(),connectionId=uuidV7(),conversationId=uuidV7();
  const empty=await snapshot(owner,'HailRelationship');
  await db.sql.begin(async tx=>{
   await tx`INSERT INTO account_conversation_preferences(account_id,allow_introductions) VALUES(${owner.account_id},true)`;
   await tx`INSERT INTO connection_conversation_preferences(account_id,connection_id,epoch,allow_introductions) VALUES(${owner.account_id},${connectionId},1,false)`;
   await tx`INSERT INTO conversation_descriptors(creator_did,conversation_id,descriptor_hash,descriptor_cose,participants,created_at,admission_until,signing_key,signing_evidence)
    VALUES(${owner.did},${conversationId},${randomBytes(32)},${randomBytes(40)},${[owner.did,freshDid(),freshDid()]},clock_timestamp(),clock_timestamp()+interval '1 day','fixture','{}')`;
   await tx`INSERT INTO conversation_memberships(account_id,creator_did,conversation_id,state) VALUES(${owner.account_id},${owner.did},${conversationId},'active')`;
  });
  const loaded=await snapshot(owner,'HailRelationship');expect(loaded.list).toHaveLength(3);
  expect((await jmap.changes(owner,'HailRelationship',{sinceState:empty.state})).created.sort()).toEqual(loaded.list.map(row=>row.id).sort());
  await db.sql`UPDATE account_conversation_preferences SET allow_introductions=allow_introductions WHERE account_id=${owner.account_id}`;
  expect(await snapshot(owner,'HailRelationship')).toEqual(loaded);
  await db.sql.begin(async tx=>{
   await tx`UPDATE account_conversation_preferences SET allow_introductions=false,updated_at=clock_timestamp() WHERE account_id=${owner.account_id}`;
   await tx`UPDATE connection_conversation_preferences SET allow_introductions=true,updated_at=clock_timestamp() WHERE account_id=${owner.account_id}`;
   await tx`UPDATE conversation_memberships SET state='left',left_at=clock_timestamp() WHERE account_id=${owner.account_id}`;
  });
  const updated=await snapshot(owner,'HailRelationship');expect(updated.list.find(row=>row.kind==='preferences')).toMatchObject({allowIntroductions:false});
  expect(updated.list.find(row=>row.kind==='connectionPreferences')).toMatchObject({allowIntroductions:true});
  expect(updated.list.find(row=>row.kind==='membership')).toMatchObject({state:'left'});
  expect((await jmap.changes(owner,'HailRelationship',{sinceState:loaded.state})).updated.sort()).toEqual(loaded.list.map(row=>row.id).sort());
  await db.sql`DELETE FROM connection_conversation_preferences WHERE account_id=${owner.account_id}`;
  expect((await jmap.changes(owner,'HailRelationship',{sinceState:updated.state})).destroyed).toEqual([loaded.list.find(row=>row.kind==='connectionPreferences')!.id]);
 });
});
