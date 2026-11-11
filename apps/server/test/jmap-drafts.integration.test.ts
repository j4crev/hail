import Ajv from 'ajv';
import draftSchema from '../../../spec/schemas/jmap-draft-v1.json';
import contentSchema from '../../../spec/schemas/provider-draft.json';
import builderSchema from '../../../spec/schemas/content-builder-draft.json';
import {randomBytes,randomUUID} from 'node:crypto';
import {SQL} from 'bun';
import {Hono} from 'hono';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {ProviderDatabase} from '../src/db/database.js';
import {AccountDrafts,consumeDraft} from '../src/accounts/drafts.js';
import {MessageTrash} from '../src/accounts/message-trash.js';
import {JmapDrafts,HAIL_DRAFTS} from '../src/jmap/drafts.js';
import {JmapMessages,JMAP_CORE} from '../src/jmap/messages.js';
import {registerJmapRoutes} from '../src/jmap/routes.js';
import type {AccountApiRepository,AccountApiSession} from '../src/accounts/repository.js';
import {uuidV7} from '../src/identity/uuid-v7.js';
const integration=process.env.DATABASE_URL?describe:describe.skip;
const content={audience:'connections',connections:[],category:'',title:'Unfinished',text:'',alt:'',caption:'',header:null,forward:null,allowReply:false};
const origin='https://drafts.example.com';
integration('JMAP draft synchronization',()=>{
  let admin:SQL,db:ProviderDatabase,schema:string,drafts:AccountDrafts,jmap:JmapDrafts,backfillAccount:AccountApiSession,backfillId:string;
  beforeAll(async()=>{
    admin=new SQL(process.env.DATABASE_URL!);schema=`jmap_drafts_${randomUUID().replaceAll('-','')}`;
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);const url=new URL(process.env.DATABASE_URL!);url.searchParams.set('options',`-csearch_path=${schema}`);
    db=new ProviderDatabase(url.toString());await db.migrate();drafts=new AccountDrafts(db.sql);jmap=new JmapDrafts(db.sql,origin);
    const reserved=await db.sql.reserve();
    try{await reserved.unsafe(await Bun.file(new URL('../migrations/rollback/0113_jmap_drafts.sql',import.meta.url)).text());}
    finally{await reserved.unsafe('ROLLBACK');reserved.release();}
    backfillAccount=await account();backfillId=uuidV7();await drafts.mutate(backfillAccount,backfillId,'save',{revision:0,content});
    await db.migrate();
  });
  afterAll(async()=>{if(db)await db.close();if(admin){if(schema)await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);await admin.close();}});
  async function account():Promise<AccountApiSession>{
    const id=randomUUID(),did='did:plc:'+Array.from(randomBytes(24),b=>'abcdefghijklmnopqrstuvwxyz234567'[b%32]).join('');
    await db.sql`INSERT INTO provider_accounts(id,tenant_id,canonical_address,did,onboarding_state,activated_at,activation_binding_digest,activation_verification_mode)
      VALUES(${id},${randomUUID()},${id+'@drafts.example.com'},${did},'active',now(),${randomBytes(32)},'public')`;
    return {account_id:id,did,passkey_credential_id:'fixture',scopes:['messages:read'],serving_generation:1,migration_state:null} as AccountApiSession;
  }
  const snapshot=(session:AccountApiSession)=>jmap.get(session,{});
  it('creates, conditionally edits, trashes and destroys drafts through JMAP',async()=>{
    const a:AccountApiSession={...await account(),scopes:['messages:read','messages:write']},draftId=uuidV7(),empty=await snapshot(a);
    const created=await jmap.set(a,{ifInState:empty.state,create:{draft:{draftId,content}}});
    const id=(created.created!.draft as {id:string}).id;
    expect((await snapshot(a)).list[0]).toMatchObject({id,draftId,content,revision:1});
    await expect(jmap.set(a,{ifInState:empty.state,update:{[id]:{content:{...content,text:'stale'}}}})).rejects.toMatchObject({type:'stateMismatch'});
    expect((await jmap.set(a,{destroy:[id]})).notDestroyed).toEqual({[id]:{type:'forbidden'}});
    const changed=await jmap.set(a,{ifInState:created.newState,update:{[id]:{content:{...content,text:'new'}}}});
    expect((await snapshot(a)).list[0]).toMatchObject({revision:2,content:{...content,text:'new'}});
    const trashed=await jmap.set(a,{ifInState:changed.newState,update:{[id]:{isInTrash:true}}});
    const noop=await jmap.set(a,{update:{[id]:{isInTrash:true}}});expect(noop.newState).toBe(trashed.newState);
    expect((await jmap.set(a,{update:{[id]:{content}}})).notUpdated).toEqual({[id]:{type:'forbidden'}});
    const removed=await jmap.set(a,{ifInState:noop.newState,destroy:[id]});expect(removed.destroyed).toEqual([id]);
    expect((await snapshot(a)).list).toEqual([]);
    await expect(jmap.set({...a,scopes:['messages:read']},{create:{draft:{draftId:uuidV7(),content}}})).rejects.toMatchObject({type:'forbidden'});
  });
  it('serializes competing JMAP edits and keeps invalid patches atomic',async()=>{
    const a:AccountApiSession={...await account(),scopes:['messages:read','messages:write']};
    const first=await jmap.set(a,{create:{one:{draftId:uuidV7(),content},two:{draftId:uuidV7(),content}}});
    const one=(first.created!.one as {id:string}).id,two=(first.created!.two as {id:string}).id;
    const results=await Promise.allSettled(['first','second'].map(text=>jmap.set(a,{ifInState:first.newState,update:{[one]:{content:{...content,text}}}})));
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect(results.find(r=>r.status==='rejected')).toMatchObject({reason:{type:'stateMismatch'}});
    const mixed=await jmap.set(a,{update:{[one]:{content:{...content,text:'must not apply'},revision:99},[two]:{isInTrash:true}}});
    expect(mixed.notUpdated).toEqual({[one]:{type:'invalidProperties',properties:['revision']}});
    const records=(await snapshot(a)).list;
    expect((records.find(r=>r.id===one)!.content as typeof content).text).not.toBe('must not apply');
    expect(records.find(r=>r.id===two)!.isInTrash).toBe(true);
    const restored=await jmap.set(a,{ifInState:mixed.newState,update:{[two]:{isInTrash:false,content:{...content,text:'restored'}}}});
    expect(restored.notUpdated).toBeNull();
    await jmap.set(a,{update:{[two]:{isInTrash:true}}});
    await db.sql`UPDATE account_message_drafts SET trashed_at=clock_timestamp()-interval '31 days' WHERE account_id=${a.account_id}
      AND id=(SELECT draft_id FROM jmap_drafts WHERE account_id=${a.account_id} AND id=${two.slice(2)}::uuid)`;
    const expired=await snapshot(a);
    expect((await jmap.set(a,{update:{[two]:{isInTrash:false,content}}})).notUpdated).toEqual({[two]:{type:'notFound'}});
    expect((await snapshot(a)).state).toBe(expired.state);
  });
  it('backfills preexisting drafts once and preserves identities across migration reruns',async()=>{
    const before=await snapshot(backfillAccount);expect(before.list).toHaveLength(1);expect(before.list[0]!.draftId).toBe(backfillId);
    await db.migrate();expect(await snapshot(backfillAccount)).toEqual(before);
    await expect(db.sql`UPDATE account_message_drafts SET id=${uuidV7()} WHERE account_id=${backfillAccount.account_id} AND id=${backfillId}`).rejects.toThrow('identity is immutable');
  });
  it('isolates editable content and paginates metadata with stable anchors',async()=>{
    const a=await account(),b=await account(),id=uuidV7();
    const references={...content,connections:[uuidV7()],forward:{sender:b.did,messageId:uuidV7()},attachments:[{filename:'example.log',media_type:'text/plain',size:18,digest:{algorithm:'sha-256',value:'mPzEekj2Ckxc1rY5BJjQ1es6CaCnekomXKQGjTcqx7E'}}]};
    await drafts.mutate(a,id,'save',{revision:0,content:references});const initial=await snapshot(a),record=initial.list[0]!;
    expect(record).toMatchObject({draftId:id,content:references,revision:1,isInTrash:false,trashedAt:null});
    const validate=new Ajv().addSchema(builderSchema,'content-builder-draft.json').addSchema(contentSchema,'provider-draft.json').compile(draftSchema);
    expect(validate(record),JSON.stringify(validate.errors)).toBe(true);
    expect((await jmap.get(b,{ids:[record.id]})).notFound).toEqual([record.id]);
    expect((await jmap.get(a,{ids:[record.id,record.id,'missing'],properties:[]})).list).toEqual([{id:record.id}]);
    expect((await jmap.query(a,{filter:{draftId:id,inTrash:false},anchor:record.id,calculateTotal:true}))).toMatchObject({ids:[record.id],total:1,position:0});
    expect((await jmap.query(a,{position:-1,limit:0})).ids).toEqual([]);
    await expect(jmap.query(a,{anchor:'missing'})).rejects.toMatchObject({type:'anchorNotFound'});
    await expect(jmap.get({...a,passkey_credential_id:null},{})).rejects.toMatchObject({type:'accountNotSupportedByMethod'});
    expect((await snapshot(a)).state).toBe(initial.state);
  });
  it('converges after saves, Trash, restoration and atomic send consumption without resurrecting IDs',async()=>{
    const a=await account(),id=uuidV7(),empty=await snapshot(a);
    await drafts.mutate(a,id,'save',{revision:0,content});const first=await snapshot(a),record=first.list[0]!.id;
    await drafts.mutate(a,id,'save',{revision:1,content:{...content,text:'Saved on another device'}});
    await drafts.mutate(a,id,'delete',{});await drafts.mutate(a,id,'restore',{});
    const beforeRejectedSend=await snapshot(a);
    await expect(db.sql.begin(async tx=>{await consumeDraft(tx as SQL,a,id,4);throw Error('send rejected');})).rejects.toThrow('send rejected');
    const retained=await snapshot(a);expect(retained.state).toBe(beforeRejectedSend.state);expect(retained.list[0]).toMatchObject({revision:4,isInTrash:false});
    await db.sql.begin(tx=>consumeDraft(tx as SQL,a,id,4));
    expect((await jmap.changes(a,{sinceState:retained.state})).destroyed).toEqual([record]);
    await drafts.mutate(a,id,'save',{revision:0,content});
    const final=await snapshot(a);expect(final.list[0]!.id).not.toBe(record);
    for(const starting of [empty,first]){
      let state=starting.state;const cache=new Map(starting.list.map(item=>[item.id,item]));let pages=0;
      while(true){const delta=await jmap.changes(a,{sinceState:state,maxChanges:1});
        for(const id of delta.destroyed)cache.delete(id);
        const page=await jmap.get(a,{ids:[...delta.created,...delta.updated]});
        for(const id of page.notFound)cache.delete(id);for(const item of page.list)cache.set(item.id,item);
        state=delta.newState;pages++;if(!delta.hasMoreChanges)break;
      }
      expect(pages).toBeGreaterThan(1);expect([...cache.values()]).toEqual(final.list);
    }
    expect((await new JmapDrafts(db.sql,origin).get(a,{})).state).toBe(final.state);
  });
  it('captures expiry and preference cleanup and rejects expired or foreign collection states',async()=>{
    const a=await account(),id=uuidV7();await drafts.mutate(a,id,'save',{revision:0,content});
    await drafts.mutate(a,id,'delete',{});
    await db.sql`UPDATE account_message_drafts SET trashed_at=clock_timestamp()-interval '31 days' WHERE account_id=${a.account_id} AND id=${id}`;
    const before=await snapshot(a);await new MessageTrash(db.sql).purgeExpired();
    expect((await jmap.changes(a,{sinceState:before.state})).destroyed).toEqual([before.list[0]!.id]);
    const current=await snapshot(a);
    await db.sql`UPDATE jmap_draft_changes SET occurred_at=clock_timestamp()-interval '32 days' WHERE account_id=${a.account_id}`;
    await jmap.changes(a,{sinceState:current.state});
    await expect(jmap.changes(a,{sinceState:before.state})).rejects.toMatchObject({type:'cannotCalculateChanges'});
    const messageState=(await new JmapMessages(db.sql,origin).get(a,{})).state;
    await expect(jmap.changes(a,{sinceState:messageState})).rejects.toMatchObject({type:'cannotCalculateChanges'});
    await expect(jmap.changes({...a,serving_generation:2},{sinceState:current.state})).rejects.toMatchObject({type:'cannotCalculateChanges'});
    const next=uuidV7();await drafts.mutate(a,next,'save',{revision:0,content});await drafts.mutate(a,next,'delete',{});
    const pending=await snapshot(a);await new MessageTrash(db.sql).saveSettings(a,false);
    expect((await jmap.changes(a,{sinceState:pending.state})).destroyed).toEqual([pending.list[0]!.id]);
  });
  it('bounds draft content before transfer to the application and permits metadata-only reads',async()=>{
    const a=await account();
    // Storage-limit fixture deliberately bypasses content parsing, not triggers.
    for(let n=0;n<8;n++)await db.sql`INSERT INTO account_message_drafts(account_id,id,content)
      VALUES(${a.account_id},${uuidV7()},${JSON.stringify({text:'x'.repeat(300000)})}::text::jsonb)`;
    await expect(snapshot(a)).rejects.toMatchObject({type:'requestTooLarge'});
    const metadata=await jmap.get(a,{properties:['draftId','revision']});expect(metadata.list).toHaveLength(8);
    expect((await jmap.get(a,{ids:[metadata.list[0]!.id]})).list).toHaveLength(1);
  });
  it('serializes independent draft commits before exposing a newer change state',async()=>{
    const a=await account(),one=uuidV7(),two=uuidV7();
    for(const id of [one,two])await drafts.mutate(a,id,'save',{revision:0,content});
    const before=await snapshot(a);let release!:()=>void,ready!:()=>void;
    const gate=new Promise<void>(r=>{release=r}),started=new Promise<void>(r=>{ready=r});
    let first:Promise<unknown>|undefined,second:Promise<unknown>|undefined;
    try{
      first=db.sql.begin(async tx=>{await tx`UPDATE account_message_drafts SET revision=revision+1 WHERE account_id=${a.account_id} AND id=${one}`;ready();await gate;});
      await started;second=db.sql`UPDATE account_message_drafts SET revision=revision+1 WHERE account_id=${a.account_id} AND id=${two}`.execute();
      expect((await db.sql`SELECT revision::text FROM jmap_draft_states WHERE account_id=${a.account_id}`)[0]!.revision).toBe('2');
      release();await Promise.all([first,second]);expect((await jmap.changes(a,{sinceState:before.state})).updated).toHaveLength(2);
    }finally{release();await Promise.allSettled([first,second]);}
  });
  it('advertises draft reads only to passkey sessions and requires capability opt-in',async()=>{
    let session=await account();await drafts.mutate(session,uuidV7(),'save',{revision:0,content});
    const accounts={authenticate:async()=>session} as unknown as AccountApiRepository;
    const messages=new JmapMessages(db.sql,origin),app=new Hono();registerJmapRoutes(app,accounts,messages,origin,origin,jmap);
    const accountId=messages.accountId(session);
    const discovered=await (await app.request(origin+'/.well-known/jmap')).json();expect(discovered.primaryAccounts[HAIL_DRAFTS]).toBe(accountId);
    const request=(using=[JMAP_CORE,HAIL_DRAFTS])=>app.request(origin+'/jmap',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({using,methodCalls:[['HailDraft/query',{accountId},'q'],['HailDraft/get',{accountId,'#ids':{name:'HailDraft/query',resultOf:'q',path:'/ids'}},'g']]})});
    expect((await (await request()).json()).methodResponses[1][1].list).toHaveLength(1);
    expect((await (await request([JMAP_CORE])).json()).methodResponses[0][1]).toEqual({type:'unknownMethod'});
    session={...session,passkey_credential_id:null};
    expect((await (await app.request(origin+'/.well-known/jmap')).json()).primaryAccounts[HAIL_DRAFTS]).toBeUndefined();
    expect((await (await request()).json()).methodResponses[0][1]).toEqual({type:'accountNotSupportedByMethod'});
  });
});
