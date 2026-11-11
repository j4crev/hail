import {MessageTrash} from '../src/accounts/message-trash.js';
import {randomBytes,randomUUID} from 'node:crypto';
import {SQL} from 'bun';
import {Hono} from 'hono';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {ProviderDatabase} from '../src/db/database.js';
import type {AccountApiRepository,AccountApiSession} from '../src/accounts/repository.js';
import {JmapMessages,JMAP_CORE} from '../src/jmap/messages.js';
import {JmapDrafts,HAIL_DRAFTS} from '../src/jmap/drafts.js';
import {JmapBlobs,MAX_UPLOAD_BYTES} from '../src/jmap/blobs.js';
import {registerJmapRoutes} from '../src/jmap/routes.js';
const integration=process.env.DATABASE_URL?describe:describe.skip,origin='https://core.example.com';
integration('JMAP Core binary and request behavior',()=>{
  let admin:SQL,db:ProviderDatabase,schema:string,messages:JmapMessages;
  beforeAll(async()=>{
    admin=new SQL(process.env.DATABASE_URL!);schema='jmap_core_'+randomUUID().replaceAll('-','');
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);
    const url=new URL(process.env.DATABASE_URL!);url.searchParams.set('options',`-csearch_path=${schema}`);
    db=new ProviderDatabase(url.toString());await db.migrate();messages=new JmapMessages(db.sql,origin);
  });
  afterAll(async()=>{await db?.close();if(admin){if(schema)await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);await admin.close();}});
  async function account():Promise<AccountApiSession>{
    const id=randomUUID(),did='did:plc:'+Array.from(randomBytes(24),b=>'abcdefghijklmnopqrstuvwxyz234567'[b%32]).join('');
    await db.sql`INSERT INTO provider_accounts(id,tenant_id,canonical_address,did,onboarding_state,activated_at,activation_binding_digest,activation_verification_mode)
      VALUES(${id},${randomUUID()},${id+'@core.example.com'},${did},'active',now(),${randomBytes(32)},'public')`;
    return {account_id:id,did,credential_id:randomUUID(),credential_expires_at:new Date(Date.now()+60_000),canonical_address:id+'@core.example.com',
      passkey_credential_id:'fixture',scopes:['messages:read','messages:write'],serving_generation:1,migration_state:null};
  }
  function server(...sessions:AccountApiSession[]){
    const accounts={authenticate:async(auth?:string)=>sessions.find(s=>auth==='Bearer '+s.account_id)??null} as unknown as AccountApiRepository;
    const app=new Hono();registerJmapRoutes(app,accounts,messages,origin,origin,new JmapDrafts(db.sql,origin),new JmapBlobs(db.sql,origin,messages));return app;
  }
  const headers=(s:AccountApiSession)=>({Authorization:'Bearer '+s.account_id});
  const call=(app:Hono,s:AccountApiSession,methodCalls:unknown[],extra={})=>app.request(origin+'/jmap',{method:'POST',headers:{...headers(s),'Content-Type':'application/json'},
    body:JSON.stringify({using:[JMAP_CORE,HAIL_DRAFTS],methodCalls,...extra})});
  const upload=(app:Hono,s:AccountApiSession,bytes:Uint8Array,extra={})=>app.request(origin+'/jmap/upload/'+messages.accountId(s),
    {method:'POST',headers:{...headers(s),'Content-Type':'application/octet-stream',...extra},body:Uint8Array.from(bytes)});
  const download=(app:Hono,s:AccountApiSession,id:string,accountId=messages.accountId(s))=>app.request(origin+`/jmap/download/${accountId}/${id}/fixture.bin`,{headers:headers(s)});
  it('uploads and downloads exact binary bytes, including empty content, without leaking across accounts',async()=>{
    const a=await account(),b=await account(),app=server(a,b),bytes=Uint8Array.from([0,255,128,10,13,0,42]);
    const discovery=await (await app.request(origin+'/.well-known/jmap',{headers:headers(a)})).json();
    expect(discovery.capabilities[JMAP_CORE]).toMatchObject({maxSizeUpload:MAX_UPLOAD_BYTES,maxConcurrentUpload:2});
    const response=await upload(app,a,bytes);expect(response.status).toBe(200);
    const blob=await response.json();expect(blob).toMatchObject({accountId:messages.accountId(a),size:bytes.length,type:'application/octet-stream'});
    const fetched=await download(app,a,blob.blobId);expect(fetched.status).toBe(200);
    expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(bytes);expect(fetched.headers.get('content-type')).toBe('application/octet-stream');
    expect(fetched.headers.get('cache-control')).toBe('no-store');expect(fetched.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await download(app,b,blob.blobId)).status).toBe(404);
    expect((await download(app,b,blob.blobId,messages.accountId(a))).status).toBe(404);
    const empty=await upload(app,a,new Uint8Array());expect(empty.status).toBe(200);
    const emptyBlob=await empty.json();expect(emptyBlob.size).toBe(0);
    expect((await (await download(app,a,emptyBlob.blobId)).arrayBuffer()).byteLength).toBe(0);
  });
  it('copies only accessible unexpired blobs and rejects foreign account selectors',async()=>{
    const a=await account(),b=await account(),app=server(a,b),accountId=messages.accountId(a),blob=await (await upload(app,a,randomBytes(16))).json();
    const copied=await (await call(app,a,[['Blob/copy',{accountId,fromAccountId:accountId,blobIds:[blob.blobId,blob.blobId,'u_missing']},'copy']])).json();
    expect(copied.methodResponses[0]).toEqual(['Blob/copy',{accountId,fromAccountId:accountId,copied:{[blob.blobId]:blob.blobId},notCopied:{u_missing:{type:'notFound'}}},'copy']);
    for(const args of [{accountId,fromAccountId:messages.accountId(b),blobIds:[blob.blobId]},{accountId:messages.accountId(b),fromAccountId:accountId,blobIds:[blob.blobId]}]){
      const result=await (await call(app,a,[['Blob/copy',args,'copy']])).json();
      expect(result.methodResponses[0][0]).toBe('error');expect(result.methodResponses[0][1].type).toBe(args.accountId===accountId?'fromAccountNotFound':'accountNotFound');
    }
    await db.sql`UPDATE jmap_uploads SET expires_at=clock_timestamp()-interval '1 second' WHERE account_id=${a.account_id}`;
    expect((await download(app,a,blob.blobId)).status).toBe(404);
    const expired=await (await call(app,a,[['Blob/copy',{accountId,fromAccountId:accountId,blobIds:[blob.blobId]},'copy']])).json();
    expect(expired.methodResponses[0][1]).toMatchObject({copied:null,notCopied:{[blob.blobId]:{type:'notFound'}}});
    await new MessageTrash(db.sql).purgeExpired();
    expect(await db.sql`SELECT id FROM jmap_uploads WHERE account_id=${a.account_id}`).toHaveLength(0);
  });
  it('isolates uploads by serving generation and enforces upload authorization and encoding limits',async()=>{
    const a=await account(),app=server(a),oldAccountId=messages.accountId(a),blob=await (await upload(app,a,randomBytes(4))).json();
    a.scopes=['messages:read'];expect((await upload(app,a,new Uint8Array([1]))).status).toBe(403);a.scopes=['messages:read','messages:write'];
    a.migration_state='fenced';expect((await upload(app,a,new Uint8Array([1]))).status).toBe(403);a.migration_state=null;
    expect((await upload(app,a,new Uint8Array([1]),{'Content-Encoding':'gzip'})).status).toBe(415);
    expect((await upload(app,a,new Uint8Array([1]),{'Content-Length':String(MAX_UPLOAD_BYTES+1)})).status).toBe(413);
    await db.sql.begin(async tx=>{await tx`SELECT set_config('hail.returning_account',${a.account_id},true)`;
      await tx`UPDATE account_serving_generations SET generation=generation+1 WHERE account_id=${a.account_id}`;});
    a.serving_generation=2;expect(messages.accountId(a)).not.toBe(oldAccountId);
    expect((await download(app,a,blob.blobId,oldAccountId)).status).toBe(404);
    expect((await download(app,a,blob.blobId)).status).toBe(404);
    const fresh=await upload(app,a,new Uint8Array([2]));expect(fresh.status).toBe(200);
    expect(new Uint8Array(await (await download(app,a,(await fresh.json()).blobId)).arrayBuffer())).toEqual(new Uint8Array([2]));
  });
  it('ignores unknown outer request properties and resolves created IDs without rewriting draft text',async()=>{
    const a=await account(),app=server(a),accountId=messages.accountId(a),draftId=Bun.randomUUIDv7();
    const content={audience:'connections',connections:[],category:'',title:'Unfinished',text:'#saved',alt:'',caption:'',header:null,forward:null,allowReply:false};
    const response=await call(app,a,[['HailDraft/set',{accountId,create:{saved:{draftId,content}}},'create'],
      ['HailDraft/get',{accountId,ids:['#saved']},'get'],['Core/echo',{text:'#saved'},'echo']],{createdIds:{retained:'opaque'},futureExtension:{ignored:true}});
    expect(response.status).toBe(200);const result=await response.json(),id=result.createdIds.saved;
    expect(id).toMatch(/^d_[0-9a-f]{32}$/);expect(result.createdIds.retained).toBe('opaque');
    expect(result.methodResponses[1]).toMatchObject(['HailDraft/get',{list:[{id,draftId,content}]},'get']);
    expect(result.methodResponses[2]).toEqual(['Core/echo',{text:'#saved'},'echo']);
    const replay=await (await call(app,a,[['HailDraft/get',{accountId,ids:['#previous']},'get']],{createdIds:{previous:id}})).json();
    expect(replay.methodResponses[0][1].list[0].id).toBe(id);
    const updated=await (await call(app,a,[['HailDraft/set',{accountId,update:{'#previous':{content:{...content,text:'Edited'}}}},'edit']],{createdIds:{previous:id}})).json();
    expect(updated.methodResponses[0][1].updated).toHaveProperty(id);
  });
});
