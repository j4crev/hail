import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {SQL} from 'bun';
import Ajv from 'ajv';
import messageSchema from '../../../spec/schemas/jmap-message-v1.json';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {Hono} from 'hono';
import {ProviderDatabase} from '../src/db/database.js';
import {AccountApiRepository,type AccountApiSession} from '../src/accounts/repository.js';
import {JmapMessages,HAIL_MESSAGES,JMAP_CORE} from '../src/jmap/messages.js';
import {registerJmapRoutes} from '../src/jmap/routes.js';
const integration=process.env.DATABASE_URL?describe:describe.skip;
const origin='https://jmap.example.com';
integration('JMAP received message synchronization',()=>{
  let admin:SQL,db:ProviderDatabase,schema:string,messages:JmapMessages;
  beforeAll(async()=>{
    admin=new SQL(process.env.DATABASE_URL!);schema=`jmap_${randomUUID().replaceAll('-','')}`;
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);
    const url=new URL(process.env.DATABASE_URL!);url.searchParams.set('options',`-csearch_path=${schema}`);
    db=new ProviderDatabase(url.toString());await db.migrate();messages=new JmapMessages(db.sql,origin);
  });
  afterAll(async()=>{if(db)await db.close();if(admin){if(schema)await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);await admin.close();}});
  async function account():Promise<AccountApiSession>{
    const id=randomUUID(),did=`did:plc:${Array.from(randomBytes(24),b=>'abcdefghijklmnopqrstuvwxyz234567'[b%32]).join('')}`,address=`${id}@jmap.example.com`;
    await db.sql`INSERT INTO provider_accounts(id,tenant_id,canonical_address,did,onboarding_state,activated_at,activation_binding_digest,activation_verification_mode)
      VALUES(${id},${randomUUID()},${address},${did},'active',now(),${randomBytes(32)},'public')`;
    return {account_id:id,credential_id:randomUUID(),credential_expires_at:new Date(Date.now()+60000),did,canonical_address:address,scopes:['messages:read'],migration_state:null,serving_generation:1};
  }
  async function deliver(session:AccountApiSession,sharedBody?:Buffer){
    const id=randomUUID(),sender='did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',body=sharedBody??randomBytes(60),envelope=randomBytes(100),digest=createHash('sha256').update(body).digest(),edigest=createHash('sha256').update(envelope).digest();
    await db.sql`INSERT INTO verified_body_provenance(recipient_did,sender_did,digest,media_type,profile,body_bytes)
      VALUES(${session.did},${sender},${digest},'application/hail-body+cbor','spt-3',${body}) ON CONFLICT DO NOTHING`;
    await db.sql`INSERT INTO received_envelopes(sender_did,message_id,recipient_did,grant_id,local_account_id,envelope_cose,envelope_digest,
      payload_digest,signing_public_key,signing_plc_document,signing_plc_data,signing_plc_operation_log,outcome,accepted_at,authorization_type,connection_id,connection_epoch)
      VALUES(${sender},${id},${session.did},NULL,${session.account_id},${envelope},${edigest},${randomBytes(32)},'did:key:test','{}','{}','[]','accepted',now(),'connection',${randomUUID()},1)`;
    await db.sql`INSERT INTO delivered_messages(recipient_did,sender_did,message_id,envelope_digest,body_digest,media_type,profile)
      VALUES(${session.did},${sender},${id},${edigest},${digest},'application/hail-body+cbor','spt-3')`;
    return {id,sender,body,envelope};
  }
  it('cleans derived state when transfer activation releases a temporary account reservation',async()=>{
    const id=randomUUID();
    await db.sql`INSERT INTO provider_accounts(id,tenant_id,canonical_address,onboarding_state) VALUES(${id},${randomUUID()},${id+'@jmap.example.com'},'reserved')`;
    expect(await db.sql`SELECT 1 FROM jmap_message_states WHERE account_id=${id}`).toHaveLength(1);
    await db.sql`DELETE FROM provider_accounts WHERE id=${id} AND did IS NULL AND onboarding_state='reserved'`;
    expect(await db.sql`SELECT 1 FROM jmap_message_states WHERE account_id=${id}`).toHaveLength(0);
  });
  const snapshot=(s:AccountApiSession)=>messages.get(s,{ids:null});
  it('preserves exact bytes, isolates accounts and supports filtered/anchored reads without marking read',async()=>{
    const a=await account(),b=await account(),sent=await deliver(a);
    const initial=await snapshot(a),item=initial.list[0]!;expect(item.isRead).toBe(false);
    const validate=new Ajv().compile(messageSchema);expect(validate(item),JSON.stringify(validate.errors)).toBe(true);
    expect(Buffer.from(item.envelope as string,'base64url')).toEqual(sent.envelope);
    expect(Buffer.from((await messages.blob(a,item.bodyBlobId as string))!.bytes)).toEqual(sent.body);
    expect(await messages.blob(b,item.bodyBlobId as string)).toBeNull();
    expect((await messages.get(b,{ids:[item.id]})).notFound).toEqual([item.id]);
    expect((await messages.get(a,{ids:[item.id,item.id,'bad'],properties:[]})).list).toEqual([{id:item.id}]);
    expect((await messages.query(a,{filter:{isRead:false,inTrash:false},anchor:item.id,calculateTotal:true}))).toMatchObject({ids:[item.id],total:1,position:0});
    await expect(messages.query(a,{anchor:'bad'})).rejects.toMatchObject({type:'anchorNotFound'});
    expect((await snapshot(a)).state).toBe(initial.state);
    expect((await messages.query(a,{position:-1,limit:0})).ids).toEqual([]);
  });
  it('converges two clients across paged delivery, read, Trash, restoration and permanent deletion',async()=>{
    const a=await account(),empty=await snapshot(a),first=await deliver(a),second=await deliver(a);
    const loaded=await snapshot(a),firstId=loaded.list.find(m=>m.messageId===first.id)!.id;
    await db.sql`UPDATE delivered_messages SET is_read=true,trashed_at=clock_timestamp() WHERE message_id=${first.id}`;
    await db.sql`UPDATE delivered_messages SET trashed_at=NULL WHERE message_id=${first.id}`;
    await db.sql`DELETE FROM delivered_messages WHERE message_id=${second.id}`;
    for(const initial of [empty,loaded]){
      let state=initial.state;const cache=new Map(initial.list.map(m=>[m.id,m]));let pages=0;
      while(true){
        const delta=await messages.changes(a,{sinceState:state,maxChanges:1});
        for(const id of delta.destroyed)cache.delete(id);
        const current=await messages.get(a,{ids:[...delta.created,...delta.updated]});
        for(const missing of current.notFound)cache.delete(missing);
        for(const item of current.list)cache.set(item.id,item);
        state=delta.newState;pages++;if(!delta.hasMoreChanges)break;
      }
      expect(pages).toBeGreaterThan(1);expect([...cache.values()]).toEqual((await snapshot(a)).list);
      expect([...cache.values()][0]).toMatchObject({id:firstId,isRead:true,trashedAt:null});
    }
    const coalesced=await messages.changes(a,{sinceState:empty.state});
    expect(coalesced).toMatchObject({created:[firstId],updated:[],destroyed:[],hasMoreChanges:false});
  });
  it('does not publish rolled back changes or reuse destroyed record IDs',async()=>{
    const a=await account(),sent=await deliver(a),before=await snapshot(a);
    await expect(db.sql.begin(async tx=>{await tx`UPDATE delivered_messages SET is_read=true WHERE message_id=${sent.id}`;throw Error('abort');})).rejects.toThrow('abort');
    expect(await snapshot(a)).toEqual(before);
    const row=(await db.sql`SELECT to_jsonb(m) AS row FROM delivered_messages m WHERE message_id=${sent.id}`)[0]!.row;
    await db.sql`DELETE FROM delivered_messages WHERE message_id=${sent.id}`;
    await db.sql`INSERT INTO delivered_messages SELECT * FROM jsonb_populate_record(NULL::delivered_messages,${JSON.stringify(row)}::text::jsonb)`;
    expect((await snapshot(a)).list[0]!.id).not.toBe(before.list[0]!.id);
    await expect(db.sql.begin(async tx=>tx.unsafe(await Bun.file(new URL('../migrations/rollback/0112_jmap_messages.sql',import.meta.url)).text()))).rejects.toThrow('JMAP identities prevent rollback');
  });
  it('rejects expired, future and foreign-account state tokens and keeps a durable retention floor',async()=>{
    const a=await account(),b=await account(),empty=await snapshot(a);await deliver(a);const current=await snapshot(a);
    await db.sql`UPDATE jmap_message_changes SET occurred_at=clock_timestamp()-interval '32 days' WHERE account_id=${a.account_id}`;
    await messages.changes(a,{sinceState:current.state});
    await expect(messages.changes(a,{sinceState:empty.state})).rejects.toMatchObject({type:'cannotCalculateChanges'});
    await expect(messages.changes(b,{sinceState:current.state})).rejects.toMatchObject({type:'cannotCalculateChanges'});
    await expect(messages.changes(a,{sinceState:current.state.replace(/_[0-9]+$/,'_999')})).rejects.toMatchObject({type:'cannotCalculateChanges'});
    expect(messages.accountId({...a,serving_generation:2})).not.toBe(messages.accountId(a));
    expect(new JmapMessages(db.sql,'https://destination.example.com').accountId(a)).not.toBe(messages.accountId(a));
  });
  it('serializes concurrent change commits before advancing visible state',async()=>{
    const a=await account(),first=await deliver(a),second=await deliver(a),before=await snapshot(a);
    let release!:()=>void,ready!:()=>void;
    const gate=new Promise<void>(r=>{release=r}),started=new Promise<void>(r=>{ready=r});
    let one:Promise<unknown>|undefined,two:Promise<unknown>|undefined;
    try{
      one=db.sql.begin(async tx=>{await tx`UPDATE delivered_messages SET is_read=true WHERE message_id=${first.id}`;ready();await gate;});
      await started;
      two=db.sql`UPDATE delivered_messages SET is_read=true WHERE message_id=${second.id}`.execute();
      expect((await db.sql`SELECT revision::text FROM jmap_message_states WHERE account_id=${a.account_id}`)[0]!.revision).toBe('2');
      release();await Promise.all([one,two]);
      expect((await messages.changes(a,{sinceState:before.state})).updated).toHaveLength(2);
    }finally{release();await Promise.allSettled([one,two]);}
  });
  it('updates read state with atomic preconditions, partial errors and no-op stability',async()=>{
    const a=await account(),b=await account(),first=await deliver(a),second=await deliver(a);await deliver(b);
    const writable={...a,scopes:['messages:read','messages:write'] as AccountApiSession['scopes'],passkey_credential_id:'fixture'};
    const before=await snapshot(a),one=before.list.find(m=>m.messageId===first.id)!.id as string,two=before.list.find(m=>m.messageId===second.id)!.id as string;
    expect((await messages.query(a,{filter:{sender:first.sender,messageId:first.id,inTrash:false}})).ids).toEqual([one]);
    const changed=await messages.set(writable,{ifInState:before.state,update:{[one]:{isRead:true},[two]:{isRead:'yes'},missing:{isRead:true}},create:{new:{}},destroy:[two]});
    expect(changed.updated).toEqual({[one]:null});expect(changed.notUpdated).toEqual({[two]:{type:'willDestroy'},missing:{type:'notFound'}});
    expect(changed.notCreated).toEqual({new:{type:'forbidden'}});expect(changed.notDestroyed).toEqual({[two]:{type:'forbidden'}});
    expect((await messages.set(writable,{update:{[two]:{isRead:'yes'}}})).notUpdated).toEqual({[two]:{type:'invalidProperties',properties:['isRead']}});
    expect(changed.oldState).toBe(before.state);expect(changed.newState).not.toBe(before.state);
    expect((await messages.changes(a,{sinceState:before.state})).updated).toEqual([one]);
    await expect(messages.set(writable,{ifInState:before.state,update:{[two]:{isRead:true}}})).rejects.toMatchObject({type:'stateMismatch'});
    const unchanged=await messages.set(writable,{ifInState:changed.newState,update:{[one]:{isRead:true,id:one}}});expect(unchanged.newState).toBe(changed.newState);
    const immutable=await messages.set(writable,{update:{[one]:{isRead:false,envelope:'replacement'}}});expect(immutable.notUpdated).toHaveProperty(one);expect((await messages.get(a,{ids:[one]})).list[0]!.isRead).toBe(true);
    const concurrent=await Promise.allSettled([messages.set(writable,{ifInState:changed.newState,update:{[two]:{isRead:true}}}),messages.set(writable,{ifInState:changed.newState,update:{[two]:{isRead:true}}})]);
    expect(concurrent.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(concurrent.filter(r=>r.status==='rejected')).toHaveLength(1);
    await db.sql`UPDATE delivered_messages SET trashed_at=clock_timestamp() WHERE message_id=${first.id}`;
    expect((await messages.set(writable,{update:{[one]:{isRead:false}}})).notUpdated).toEqual({[one]:{type:'forbidden'}});
    for(const denied of [a,{...writable,passkey_credential_id:null},{...writable,scopes:['messages:read'] as AccountApiSession['scopes']},{...writable,migration_state:'fenced' as const}])
      await expect(messages.set(denied,{update:{[one]:{isRead:false}}})).rejects.toMatchObject({type:'forbidden'});
    const foreign=(await snapshot(b)).list[0]!.id as string;
    expect((await messages.set(writable,{update:{[foreign]:{isRead:true}}})).notUpdated).toEqual({[foreign]:{type:'notFound'}});
  });
  it('preserves Trash deadlines, rejects expired restore and protects confirmed settings',async()=>{
    const a=await account(),sent=await deliver(a);
    const writable={...a,scopes:['messages:read','messages:write'] as AccountApiSession['scopes'],passkey_credential_id:'fixture'};
    const initial=await snapshot(a),id=initial.list[0]!.id as string;
    const move=await messages.set(writable,{ifInState:initial.state,ifTrashEnabled:true,update:{[id]:{isInTrash:true}}});
    const trashed=(await snapshot(a)).list[0]!;expect(trashed.isInTrash).toBe(true);expect(trashed.trashedAt).not.toBeNull();
    expect(move.updated).toEqual({[id]:{trashedAt:trashed.trashedAt}});
    const retry=await messages.set(writable,{update:{[id]:{isInTrash:true}}});expect(retry.newState).toBe(move.newState);
    expect((await snapshot(a)).list[0]!.trashedAt).toBe(trashed.trashedAt);
    const restored=await messages.set(writable,{ifInState:retry.newState,update:{[id]:{isInTrash:false,isRead:true}}});
    expect(restored.updated).toEqual({[id]:{trashedAt:null}});expect((await snapshot(a)).list[0]).toMatchObject({isInTrash:false,isRead:true,trashedAt:null});
    expect((await messages.set(writable,{destroy:[id]})).notDestroyed).toEqual({[id]:{type:'forbidden'}});
    const mixed=await messages.set(writable,{update:{[id]:{isInTrash:true,isRead:false}}});expect(mixed.notUpdated).toEqual({[id]:{type:'forbidden'}});
    expect((await snapshot(a)).list[0]).toMatchObject({isInTrash:false,isRead:true});
    await db.sql`UPDATE delivered_messages SET trashed_at=clock_timestamp()-interval '31 days' WHERE message_id=${sent.id}`;
    const expired=await snapshot(a);
    expect((await messages.set(writable,{update:{[id]:{isInTrash:false,isRead:false}}})).notUpdated).toEqual({[id]:{type:'notFound'}});
    expect((await snapshot(a)).state).toBe(expired.state);
    const removed=await messages.set(writable,{ifInState:expired.state,destroy:[id]});expect(removed.destroyed).toEqual([id]);
    expect(await messages.blob(a,trashed.bodyBlobId as string)).toBeNull();
    expect((await messages.changes(a,{sinceState:expired.state})).destroyed).toEqual([id]);
    const next=await deliver(a),active=(await snapshot(a)).list.find(m=>m.messageId===next.id)!.id as string;
    const state=(await snapshot(a)).state;
    await db.sql`INSERT INTO account_message_preferences(account_id,trash_enabled) VALUES(${a.account_id},false)`;
    await expect(messages.set(writable,{ifInState:state,ifTrashEnabled:true,update:{[active]:{isInTrash:true}}})).rejects.toMatchObject({type:'stateMismatch'});
    expect((await messages.set(writable,{update:{[active]:{isInTrash:true}}})).notUpdated).toEqual({[active]:{type:'forbidden'}});
    expect((await messages.set(writable,{ifInState:state,ifTrashEnabled:false,destroy:[active]})).destroyed).toEqual([active]);
  });
  it('permanent deletion preserves shared bodies until the final mailbox reference disappears',async()=>{
    const a=await account(),body=randomBytes(60),one=await deliver(a,body),two=await deliver(a,body);
    const writable={...a,scopes:['messages:read','messages:write'] as AccountApiSession['scopes'],passkey_credential_id:'fixture'};
    const initial=await snapshot(a),first=initial.list.find(m=>m.messageId===one.id)!,second=initial.list.find(m=>m.messageId===two.id)!;
    await messages.set(writable,{update:{[first.id as string]:{isInTrash:true}}});
    await messages.set(writable,{destroy:[first.id]});
    expect(Buffer.from((await messages.blob(a,second.bodyBlobId as string))!.bytes)).toEqual(body);
    await db.sql`INSERT INTO account_message_preferences(account_id,trash_enabled) VALUES(${a.account_id},false)`;
    const removed=await messages.set(writable,{ifTrashEnabled:false,destroy:[second.id]});expect(removed.destroyed).toEqual([second.id]);
    expect(await db.sql`SELECT 1 FROM verified_body_provenance WHERE recipient_did=${a.did}`).toHaveLength(0);
    expect(await db.sql`SELECT 1 FROM received_envelopes WHERE recipient_did=${a.did}`).toHaveLength(2);
  });
  it('dispatches browser read-state writes with scope, Origin and stale-state protection',async()=>{
    const a=await account();await deliver(a);
    const session:AccountApiSession={...a,scopes:['messages:read','messages:write'],passkey_credential_id:'fixture'};
    const accounts={authenticate:async()=>session} as unknown as AccountApiRepository;
    const app=new Hono();registerJmapRoutes(app,accounts,messages,origin);
    const before=await snapshot(a),id=before.list[0]!.id as string,accountId=messages.accountId(a);
    const input={using:[JMAP_CORE,HAIL_MESSAGES],methodCalls:[['HailMessage/set',{accountId,ifInState:before.state,update:{[id]:{isRead:true}}},'set']]};
    const headers={Cookie:'hail_session=fixture','Content-Type':'application/json'};
    const request=(extra:Record<string,string>={})=>app.request(origin+'/jmap',{method:'POST',headers:{...headers,...extra},body:JSON.stringify(input)});
    expect((await request()).status).toBe(403);expect((await request({Origin:'https://foreign.example'})).status).toBe(403);
    const discovery=await (await app.request(origin+'/.well-known/jmap',{headers})).json();
    expect(discovery.accounts[accountId]).toMatchObject({isReadOnly:false,accountCapabilities:{[HAIL_MESSAGES]:{mutableProperties:['isRead','isInTrash']}}});
    expect((await (await request({Origin:origin})).json()).methodResponses[0][1].updated).toEqual({[id]:null});
    expect((await (await request({Origin:origin})).json()).methodResponses[0]).toEqual(['error',{type:'stateMismatch'},'set']);
    session.passkey_credential_id=null;
    expect((await (await request({Origin:origin})).json()).methodResponses[0]).toEqual(['error',{type:'forbidden'},'set']);
    expect((await snapshot(a)).list[0]!.isRead).toBe(true);
  });
  it('authenticates HTTP discovery, batches result references and rejects scope/origin/capability bypasses',async()=>{
    const a=await account();await deliver(a);const accounts=new AccountApiRepository(db.sql),credential=await accounts.issue(a.did,false,undefined,['messages:read']);
    const app=new Hono();registerJmapRoutes(app,accounts,messages,origin);
    const headers={Authorization:`Bearer ${credential.token}`,'Content-Type':'application/json'};
    const request=(input:unknown,extra={})=>app.request(origin+'/jmap',{method:'POST',headers:{...headers,...extra},body:JSON.stringify(input)});
    expect((await app.request(origin+'/.well-known/jmap')).status).toBe(401);
    const session=await (await app.request(origin+'/.well-known/jmap',{headers})).json();const accountId=messages.accountId(a);
    expect(session.accounts[accountId].isReadOnly).toBe(true);
    const input={using:[JMAP_CORE,HAIL_MESSAGES],methodCalls:[['HailMessage/query',{accountId},'q'],['HailMessage/get',{accountId,'#ids':{resultOf:'q',name:'HailMessage/query',path:'/ids'}},'g']]};
    const response=await request(input);expect(response.status).toBe(200);
    const result=await response.json();expect(result.methodResponses[1][1].list,JSON.stringify(result)).toHaveLength(1);
    const blob=result.methodResponses[1][1].list[0].bodyBlobId;
    const downloaded=await app.request(origin+`/jmap/download/${accountId}/${blob}/body.cbor?type=application%2Foctet-stream`,{headers});
    expect(downloaded.status).toBe(200);expect(downloaded.headers.get('Content-Type')).toBe('application/octet-stream');
    expect((await request(input,{Origin:'https://evil.example'})).status).toBe(403);
    expect((await request({...input,using:['unsupported']})).status).toBe(400);
    const denied=await request({using:[JMAP_CORE],methodCalls:input.methodCalls});expect((await denied.json()).methodResponses[0][1].type).toBe('unknownMethod');
    const foreign=await request({...input,methodCalls:[['HailMessage/get',{accountId:'foreign'},'x']]});expect((await foreign.json()).methodResponses[0][1].type).toBe('accountNotFound');
    const narrow=await accounts.issue(a.did,false,undefined,['account:read']);
    const scoped=await request(input,{Authorization:`Bearer ${narrow.token}`});expect((await scoped.json()).methodResponses[0][1].type).toBe('accountNotSupportedByMethod');
    const pollution=await request({using:[JMAP_CORE],methodCalls:[['Core/echo',{value:{injected:true}},'a'],['Core/echo',{'#__proto__':{resultOf:'a',name:'Core/echo',path:'/value'}},'b']]});
    expect((await pollution.json()).methodResponses[1][1]).toHaveProperty('__proto__',{injected:true});
  });
});
