import Ajv from 'ajv';
import accountSchema from '../../../spec/schemas/jmap-account-object-v1.json';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {SQL} from 'bun';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {ProviderDatabase} from '../src/db/database.js';
import type {AccountApiSession} from '../src/accounts/repository.js';
import {JmapCollections,COLLECTIONS} from '../src/jmap/collections.js';
const integration=process.env.DATABASE_URL?describe:describe.skip;
integration('JMAP account collection synchronization',()=>{
 let admin:SQL,db:ProviderDatabase,schema:string,collections:JmapCollections;
 beforeAll(async()=>{
  admin=new SQL(process.env.DATABASE_URL!);schema=`jmap_collections_${randomUUID().replaceAll('-','')}`;
  await admin.unsafe(`CREATE SCHEMA "${schema}"`);
  const url=new URL(process.env.DATABASE_URL!);url.searchParams.set('options',`-csearch_path=${schema}`);
  db=new ProviderDatabase(url.toString());await db.migrate();collections=new JmapCollections(db.sql,'https://jmap.example.com');
 });
 afterAll(async()=>{if(db)await db.close();if(admin){if(schema)await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);await admin.close();}});
 async function account():Promise<AccountApiSession>{
  const id=randomUUID(),did=`did:plc:${Array.from(randomBytes(24),b=>'abcdefghijklmnopqrstuvwxyz234567'[b%32]).join('')}`,address=`${id}@jmap.example.com`;
  await db.sql`INSERT INTO provider_accounts(id,tenant_id,canonical_address,did,onboarding_state,activated_at,activation_binding_digest,activation_verification_mode)
   VALUES(${id},${randomUUID()},${address},${did},'active',now(),${randomBytes(32)},'public')`;
  return {account_id:id,credential_id:randomUUID(),credential_expires_at:new Date(Date.now()+60000),did,canonical_address:address,
   scopes:['account:read','messages:read','messages:write','grants:read'],passkey_credential_id:randomUUID(),migration_state:null,serving_generation:1};
 }
 async function send(s:AccountApiSession){
  const id=randomUUID(),body=randomBytes(60),digest=createHash('sha256').update(body).digest(),envelope=randomBytes(100);
  await db.sql.begin(async tx=>{
   await tx`INSERT INTO detached_bodies(digest,sender_account_id,body_bytes) VALUES(${digest},${s.account_id},${body})`;
   await tx`INSERT INTO sent_envelopes(sender_did,message_id,recipient_did,grant_id,envelope_cose,envelope_digest,body_digest,sender_account_id)
    VALUES(${s.did},${id},'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',${randomUUID()},${envelope},${createHash('sha256').update(envelope).digest()},${digest},${s.account_id})`;
   await tx`INSERT INTO sent_delivery_status(sender_did,message_id,recipient_did,current_revision,current_state,payload_bytes,cose,signing_public_key,signing_plc_document,signing_plc_data,signing_plc_operation_log)
    VALUES(${s.did},${id},'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',1,'delivered',${new Uint8Array([1])},${new Uint8Array([1])},'did:key:fixture','{}','{}','[]')`;
  });
  return {id,body,envelope};
 }
 const snapshot=(s:AccountApiSession)=>collections.get(s,'HailSent',{ids:null});
 it('initializes all collections and isolates records, state, scope and exact body bytes',async()=>{
  const a=await account(),b=await account(),sent=await send(a),loaded=await snapshot(a),item=loaded.list[0]!;
  for(const c of COLLECTIONS)expect((await collections.get(b,c,{ids:null})).list).toEqual([]);
  expect((await collections.get(b,'HailSent',{ids:[item.id,item.id]})).notFound).toEqual([item.id]);
  await expect(collections.get(a,'HailSent',{ids:[],properties:['unsupported']})).rejects.toMatchObject({type:'invalidArguments'});
  expect((await collections.get(a,'HailSent',{ids:[item.id,item.id],properties:['kind']})).list).toEqual([{id:item.id,kind:'message'}]);
  expect(Buffer.from((await collections.blob(a,item.bodyBlobId as string))!.bytes)).toEqual(sent.body);
  expect(await collections.blob(b,item.bodyBlobId as string)).toBeNull();
  await expect(collections.get({...a,scopes:[]},'HailSent',{})).rejects.toMatchObject({type:'accountNotSupportedByMethod'});
  await expect(collections.changes(b,'HailSent',{sinceState:loaded.state})).rejects.toMatchObject({type:'cannotCalculateChanges'});
  await expect(collections.changes(a,'HailSubmission',{sinceState:loaded.state})).rejects.toMatchObject({type:'cannotCalculateChanges'});
  expect(await collections.query(a,'HailSent',{filter:{sendId:sent.id},anchor:item.id,calculateTotal:true})).toMatchObject({ids:[item.id],total:1,position:0});
  const submission=(await collections.get(a,'HailSubmission',{})).list[0]!;
  for(const [type,value] of [['HailSent',item],['HailSubmission',submission]]){const validate=new Ajv().compile({$ref:'#/definitions/'+type,definitions:accountSchema.definitions});expect(validate(value),JSON.stringify(validate.errors)).toBe(true);}
  expect((submission as Record<string,unknown>).targets).toEqual([expect.objectContaining({messageId:sent.id,envelope:sent.envelope.toString('base64url')})]);
  expect((await snapshot(a)).state).toBe(loaded.state);
 });
 it('converges two readers through paged create, update and destroy without deleting submission evidence',async()=>{
  const a=await account(),empty=await snapshot(a),first=await send(a),second=await send(a),loaded=await snapshot(a);
  const firstId=loaded.list.find(row=>(row as Record<string,unknown>).sendId===first.id)!.id;
  await db.sql`INSERT INTO account_sent_dispositions(account_id,kind,send_id) VALUES(${a.account_id},'message',${first.id})`;
  await db.sql`INSERT INTO account_sent_dispositions(account_id,kind,send_id,deleted) VALUES(${a.account_id},'message',${second.id},true)`;
  for(const initial of [empty,loaded]){
   let state=initial.state,pages=0;const cache=new Map(initial.list.map(row=>[row.id,row]));
   for(;;){
    const changes=await collections.changes(a,'HailSent',{sinceState:state,maxChanges:1});
    for(const id of changes.destroyed)cache.delete(id);
    const rows=await collections.get(a,'HailSent',{ids:[...changes.created,...changes.updated]});
    for(const id of rows.notFound)cache.delete(id);for(const row of rows.list)cache.set(row.id,row);
    state=changes.newState;pages++;if(!changes.hasMoreChanges)break;
   }
   expect(pages).toBeGreaterThan(1);expect([...cache.values()]).toEqual((await snapshot(a)).list);
   expect([...cache.values()][0]).toMatchObject({id:firstId,isInTrash:true});
  }
  expect(await collections.changes(a,'HailSent',{sinceState:empty.state})).toMatchObject({created:[firstId],updated:[],destroyed:[]});
  expect((await collections.get(a,'HailSubmission',{})).list).toHaveLength(2);
  expect(await db.sql`SELECT message_id FROM sent_envelopes WHERE sender_account_id=${a.account_id}`).toHaveLength(2);
 });
 it('rejects stale writes and unpublished or rolled back state',async()=>{
  const a=await account(),empty=await snapshot(a),sent=await send(a),before=await snapshot(a);
  await expect(collections.setSent(a,{ifInState:empty.state})).rejects.toMatchObject({type:'stateMismatch'});
  await expect(db.sql.begin(async tx=>{
   await tx`INSERT INTO account_sent_dispositions(account_id,kind,send_id) VALUES(${a.account_id},'message',${sent.id})`;
   await tx`SET CONSTRAINTS ALL IMMEDIATE`;
   throw Error('abort fixture');
  })).rejects.toThrow('abort fixture');
  expect(await snapshot(a)).toEqual(before);
  expect(await collections.changes(a,'HailSent',{sinceState:before.state})).toMatchObject({created:[],updated:[],destroyed:[]});
  await expect(collections.changes(a,'HailSent',{sinceState:before.state.replace(/_[0-9]+$/,'_999')})).rejects.toMatchObject({type:'cannotCalculateChanges'});
 });
 it('expires retained change history and rejects tokens from an earlier serving generation',async()=>{
  const a=await account(),empty=await snapshot(a);await send(a);const current=await snapshot(a);
  await db.sql`UPDATE jmap_collection_changes SET occurred_at=clock_timestamp()-interval '32 days' WHERE account_id=${a.account_id}`;
  await collections.changes(a,'HailSent',{sinceState:current.state});
  await expect(collections.changes(a,'HailSent',{sinceState:empty.state})).rejects.toMatchObject({type:'cannotCalculateChanges'});
  expect(BigInt((await db.sql`SELECT retained_from FROM jmap_collection_states WHERE account_id=${a.account_id} AND collection='HailSent'`)[0]!.retained_from)).toBeGreaterThan(0n);
  await db.sql.begin(async tx=>{
   await tx`SELECT set_config('hail.returning_account',${a.account_id},true)`;
   await tx`UPDATE account_serving_generations SET generation=generation+1 WHERE account_id=${a.account_id}`;
  });
  const returned={...a,serving_generation:2},reset=await snapshot(returned);
  expect(reset.accountId).not.toBe(current.accountId);expect(reset.list[0]!.id).not.toBe(current.list[0]!.id);
  await expect(collections.changes(returned,'HailSent',{sinceState:current.state})).rejects.toMatchObject({type:'cannotCalculateChanges'});
 });
 it('uses one lock order for deferred peer writes and an explicit Sent mutation',async()=>{
  const a=await account();await send(a);const initial=await snapshot(a),id=initial.list[0]!.id;
  let ready!:()=>void,release!:()=>void;
  const marked=new Promise<void>(resolve=>ready=resolve),finish=new Promise<void>(resolve=>release=resolve);
  const writer=db.sql.begin(async tx=>{await tx`INSERT INTO jmap_dirty_accounts VALUES(${a.account_id})`;ready();await finish;});
  const running=Promise.resolve(writer);await marked;
  const mutation=collections.setSent(a,{update:{[id]:{isInTrash:true}}});
  await new Promise(resolve=>setTimeout(resolve,50));release();
  const [,result]=await Promise.all([running,mutation]);expect(result.updated).toHaveProperty(id);
  for(const sort of [[{isAscending:true,property:'id'}],[{property:'id'}]])expect((await collections.query(a,'HailSent',{sort})).ids).toContain(id);
 });
 it('rolls back only synchronization projections while preserving domain history',async()=>{
  const a=await account(),sent=await send(a);
  await db.sql`INSERT INTO account_sent_dispositions(account_id,kind,send_id) VALUES(${a.account_id},'message',${sent.id})`;
  const rollback=await Bun.file(new URL('../migrations/rollback/0116_jmap_collections.sql',import.meta.url)).text();
  await expect(db.sql.begin(async tx=>{
   // Exercise the down migration atomically without removing this suite's schema.
   await tx.unsafe(rollback.replace(/^BEGIN;\s*/,'').replace(/COMMIT;\s*$/,''));
   expect((await tx`SELECT to_regclass('jmap_objects') AS relation`)[0]!.relation).toBeNull();
   expect(await tx`SELECT message_id FROM sent_envelopes WHERE sender_account_id=${a.account_id}`).toHaveLength(1);
   expect(await tx`SELECT send_id FROM account_sent_dispositions WHERE account_id=${a.account_id}`).toHaveLength(1);
   expect(await tx`SELECT body_bytes FROM detached_bodies WHERE sender_account_id=${a.account_id}`).toHaveLength(1);
   throw Error('rollback verified');
  })).rejects.toThrow('rollback verified');
  expect((await snapshot(a)).list).toHaveLength(1);
 });
});
