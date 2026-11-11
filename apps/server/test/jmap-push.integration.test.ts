import {createECDH,createDecipheriv,hkdfSync,randomBytes,randomUUID} from 'node:crypto';
import {SQL} from 'bun';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {ProviderDatabase} from '../src/db/database.js';
import {AccountApiRepository,type AccountApiSession} from '../src/accounts/repository.js';
import {JmapPush} from '../src/jmap/push.js';
import {jmapAccountId} from '../src/jmap/common.js';
const integration=process.env.DATABASE_URL?describe:describe.skip;
const origin='https://push-provider.example.com';
integration('credential-bound encrypted JMAP push',()=>{
 let admin:SQL,db:ProviderDatabase,schema:string;
 beforeAll(async()=>{
  admin=new SQL(process.env.DATABASE_URL!);schema=`push_${randomUUID().replaceAll('-','')}`;
  await admin.unsafe(`CREATE SCHEMA "${schema}"`);
  const url=new URL(process.env.DATABASE_URL!);url.searchParams.set('options',`-csearch_path=${schema}`);
  db=new ProviderDatabase(url.toString());await db.migrate();
 });
 afterAll(async()=>{if(db)await db.close();if(admin){if(schema)await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);await admin.close();}});
 async function fixture(realCredential=false){
  const account=randomUUID(),did=`did:plc:${Array.from(randomBytes(24),b=>'abcdefghijklmnopqrstuvwxyz234567'[b%32]).join('')}`;
  await db.sql`INSERT INTO provider_accounts(id,tenant_id,canonical_address,did,onboarding_state,activated_at,activation_binding_digest,activation_verification_mode)
   VALUES(${account},${randomUUID()},${account+'@push-provider.example.com'},${did},'active',now(),${randomBytes(32)},'public')`;
  const session:AccountApiSession={account_id:account,credential_id:randomUUID(),credential_expires_at:new Date(Date.now()+86400000),did,
   canonical_address:account+'@push-provider.example.com',scopes:['messages:read'],migration_state:null,serving_generation:1};
  const accounts=new AccountApiRepository(db.sql);
  if(realCredential){const issued=await accounts.issue(did,false,undefined,['messages:read']);Object.assign(session,await accounts.authenticate('Bearer '+issued.token));}
  const receiver=createECDH('prime256v1'),vapid=createECDH('prime256v1');receiver.generateKeys();vapid.generateKeys();
  const keys={p256dh:receiver.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')};
  const config={subject:'mailto:ops@example.com',publicKey:vapid.getPublicKey().toString('base64url'),privateKey:Buffer.from(vapid.getPrivateKey().toString('hex').padStart(64,'0'),'hex').toString('base64url')};
  const state={current:session as AccountApiSession|null,states:{HailMessage:'state-one',HailDraft:'draft-one'} as Record<string,string>,status:201,retryAfter:'',fail:false};
  const deliveries:{request:Request;body:Buffer;payload:Record<string,any>}[]=[];
  const hooks={read:async()=>{},send:async()=>{}};
  const service=new JmapPush(db.sql,realCredential?accounts:{authenticateReference:async(kind:string,id:string)=>kind==='api'&&id===session.credential_id?state.current:null} as unknown as AccountApiRepository,
   origin,config,()=>['HailMessage','HailDraft'],async(_s,types)=>{const snapshot=Object.fromEntries(types.map(t=>[t,state.states[t]!]));await hooks.read();return snapshot;},async request=>{
    const body=Buffer.from(await request.arrayBuffer()),salt=body.subarray(0,16),sender=body.subarray(21,86),record=body.subarray(86);
    const ikm=Buffer.from(hkdfSync('sha256',receiver.computeSecret(sender),Buffer.from(keys.auth,'base64url'),Buffer.concat([Buffer.from('WebPush: info\0'),receiver.getPublicKey(),sender]),32));
    const cek=Buffer.from(hkdfSync('sha256',ikm,salt,Buffer.from('Content-Encoding: aes128gcm\0'),16));
    const nonce=Buffer.from(hkdfSync('sha256',ikm,salt,Buffer.from('Content-Encoding: nonce\0'),12));
    const decipher=createDecipheriv('aes-128-gcm',cek,nonce);decipher.setAuthTag(record.subarray(-16));
    const plaintext=Buffer.concat([decipher.update(record.subarray(0,-16)),decipher.final()]);
    deliveries.push({request,body,payload:JSON.parse(plaintext.subarray(0,-1).toString())});
    await hooks.send();
    if(state.fail)throw Error('lost response');
    return new Response(null,{status:state.status,headers:state.retryAfter?{'Retry-After':state.retryAfter}:{}});
   },async()=>{});
  const create=async(device=randomUUID(),extra:Record<string,unknown>={})=>service.set(session,{create:{subscription:{deviceClientId:device,url:'https://push.example.com/device',keys,types:['HailMessage','HailDraft'],...extra}}});
  const start=async()=>{const result=await create();expect(result.notCreated).toEqual({});return (result.created.subscription as {id:string}).id;};
  const due=async(id:string)=>{await db.sql`UPDATE jmap_push_subscriptions SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE id=${id}`;};
  const row=async(id:string)=>(await db.sql`SELECT * FROM jmap_push_subscriptions WHERE id=${id}`)[0];
  const verify=async(id:string)=>{const code=deliveries[0]!.payload.verificationCode;expect((await service.set(session,{update:{[id]:{verificationCode:code}}})).notUpdated).toEqual({});};
  return {accounts,session,service,state,deliveries,hooks,create,start,due,row,verify};
 }
 it('encrypts one verification, hides its code until verified, then coalesces state changes',async()=>{
  const f=await fixture(),id=await f.start(),delivery=f.deliveries[0]!;
  expect(delivery.payload).toMatchObject({'@type':'PushVerification',pushSubscriptionId:id});
  expect(delivery.body.includes(Buffer.from(delivery.payload.verificationCode))).toBe(false);
  expect(delivery.request.headers.get('content-encoding')).toBe('aes128gcm');
  expect(Number(delivery.request.headers.get('ttl'))).toBeLessThanOrEqual(300);
  const pending=(await f.service.get(f.session,{})).list[0]!;
  expect(pending.verificationCode).toBeNull();expect(pending).not.toHaveProperty('url');expect(pending).not.toHaveProperty('keys');
  expect(pending.expires).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  await expect(f.service.get(f.session,{properties:['url']})).rejects.toMatchObject({type:'forbidden'});
  expect((await f.service.set(f.session,{update:{[id]:{verificationCode:'A'.repeat(43)}}})).notUpdated[id]).toEqual({type:'invalidProperties'});
  await f.due(id);await f.service.workOne(id);expect(f.deliveries).toHaveLength(1);
  await f.verify(id);expect((await f.service.get(f.session,{})).list[0]!.verificationCode).toBe(delivery.payload.verificationCode);
  // JSONB key ordering must not cause notifications without a state change.
  await f.due(id);await f.service.workOne(id);expect(f.deliveries).toHaveLength(1);
  f.state.states.HailMessage='state-two';await f.due(id);await f.service.workOne(id);
  expect(f.deliveries[1]!.payload).toEqual({'@type':'StateChange',changed:{[jmapAccountId(origin,f.session)]:f.state.states}});
  await f.due(id);await f.service.workOne(id);expect(f.deliveries).toHaveLength(2);
  expect((await f.service.set(f.session,{destroy:[id]})).destroyed).toEqual([id]);
  expect(await f.row(id)).toBeUndefined();
 });
 it('accepts RFC UTCDate nonzero fractions and rejects unnormalised or invalid dates',async()=>{
  const f=await fixture();
  const future=new Date(Date.now()+86400000).toISOString().slice(0,19)+'.125Z';
  const result=await f.create(randomUUID(),{expires:future});expect(result.notCreated).toEqual({});
  expect((result.created.subscription as {expires:string}).expires).toBe(future.slice(0,19)+'Z');
  for(const expires of [future.slice(0,19)+'.000Z','2099-02-30T00:00:00Z'])expect((await f.create(randomUUID(),{expires})).notCreated).toMatchObject({subscription:{type:'invalidProperties'}});
 });
 it('isolates credentials and validates mutable fields, scopes and bounded subscriptions',async()=>{
  const f=await fixture(),id=await f.start(),other={...f.session,credential_id:randomUUID()};
  expect(await f.service.get(other,{ids:[id]})).toEqual({list:[],notFound:[id]});
  expect((await f.service.set(other,{update:{[id]:{types:[]}},destroy:[id]}))).toMatchObject({notUpdated:{[id]:{type:'notFound'}},notDestroyed:{[id]:{type:'notFound'}}});
  expect((await f.service.set(f.session,{update:{[id]:{url:'https://elsewhere.example.com'}}})).notUpdated[id]).toEqual({type:'invalidProperties'});
  expect((await f.create(undefined,{types:['HailSecrets']})).notCreated.subscription).toEqual({type:'invalidProperties'});
  expect((await f.create(undefined,{expires:'2030-02-30T00:00:00Z'})).notCreated.subscription).toEqual({type:'invalidProperties'});
  expect((await f.create(undefined,{url:'https://push.example.com:444/device'})).notCreated.subscription).toEqual({type:'invalidProperties'});
  for(let i=0;i<3;i++)await f.start();
  expect((await f.create()).notCreated.subscription).toEqual({type:'overQuota'});
 });
 it.each(['revoked','fenced','generation','scope'] as const)('removes %s credentials without network delivery',async reason=>{
  const f=await fixture(),id=await f.start();await f.verify(id);f.state.states.HailMessage='new-state';
  if(reason==='revoked')f.state.current=null;
  else if(reason==='fenced')f.state.current={...f.session,migration_state:'fenced'};
  else if(reason==='generation')f.state.current={...f.session,serving_generation:2};
  else f.state.current={...f.session,scopes:[]};
  await f.due(id);await f.service.workOne(id);expect(f.deliveries).toHaveLength(1);expect(await f.row(id)).toBeUndefined();
 });
 it('revalidates actual API credential references and removes revoked subscriptions',async()=>{
  const f=await fixture(true),id=await f.start();await f.verify(id);
  expect(await f.accounts.authenticateReference('api',f.session.credential_id)).toMatchObject({account_id:f.session.account_id,credential_id:f.session.credential_id});
  expect(await f.accounts.authenticateReference('api',randomUUID())).toBeNull();
  await f.accounts.revoke(f.session.credential_id);
  expect(await f.accounts.authenticateReference('api',f.session.credential_id)).toBeNull();
  f.state.states.HailMessage='new-state';await f.due(id);await f.service.workOne(id);
  expect(await f.row(id)).toBeUndefined();expect(f.deliveries).toHaveLength(1);
 });
 it('expires pending or expired subscriptions and never retries a verification network attempt',async()=>{
  const f=await fixture();f.state.fail=true;const id=await f.start();
  await f.due(id);await f.service.workOne(id);expect(f.deliveries).toHaveLength(1);
  await db.sql`UPDATE jmap_push_subscriptions SET created_at=clock_timestamp()-interval '16 minutes' WHERE id=${id}`;
  await f.service.workOne(id);expect(await f.row(id)).toBeUndefined();
  f.state.fail=false;const expired=await f.start();
  await db.sql`UPDATE jmap_push_subscriptions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${expired}`;
  await f.service.workOne(expired);expect(await f.row(expired)).toBeUndefined();expect(f.deliveries).toHaveLength(2);
 });
 it('backs off transient delivery failures, honors Retry-After, and removes gone endpoints',async()=>{
  const f=await fixture(),id=await f.start();await f.verify(id);f.state.states.HailMessage='new-state';f.state.status=429;f.state.retryAfter='600';
  await f.due(id);await f.service.workOne(id);let row=await f.row(id);expect(row.attempts).toBe(1);
  expect(row.next_attempt_at.getTime()-Date.now()).toBeGreaterThan(590000);expect(row.last_states.HailMessage).toBe('state-one');
  f.state.status=201;await f.due(id);await f.service.workOne(id);row=await f.row(id);expect(row.attempts).toBe(0);expect(row.last_states.HailMessage).toBe('new-state');
  f.state.states.HailMessage='another-state';f.state.status=410;await f.due(id);await f.service.workOne(id);expect(await f.row(id)).toBeUndefined();
 });
 it('cancels a claimed delivery when subscription types and expiry change during its state read',async()=>{
  const f=await fixture(),id=await f.start();await f.verify(id);f.state.states.HailMessage='new-state';
  const reading=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  f.hooks.read=async()=>{reading.resolve();await release.promise;};
  await f.due(id);const pending=f.service.workOne(id);await reading.promise;
  try{
   const expires=new Date(Math.floor((Date.now()+60_000)/1000)*1000).toISOString().replace('.000Z','Z');
   expect((await f.service.set(f.session,{update:{[id]:{types:[],expires}}})).notUpdated).toEqual({});
   expect((await f.row(id)).lease_token).toBeNull();
  }finally{release.resolve();await pending;}
  expect(f.deliveries).toHaveLength(1);
  await f.due(id);await f.service.workOne(id);expect(f.deliveries).toHaveLength(1);
 });
 it('preserves the verification baseline when its push response completes after verification',async()=>{
  const f=await fixture(),sent=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  f.hooks.send=async()=>{sent.resolve();await release.promise;};
  const pending=f.create();await sent.promise;
  const id=f.deliveries[0]!.payload.pushSubscriptionId as string;
  try{
   await f.verify(id);
   expect((await f.row(id)).last_states).toEqual(f.state.states);
  }finally{release.resolve();await pending;}
  expect((await f.row(id)).last_states).toEqual(f.state.states);
  await f.due(id);await f.service.workOne(id);expect(f.deliveries).toHaveLength(1);
 });
 it('keeps a committed creation successful when immediate worker dispatch fails before claiming it',async()=>{
  const f=await fixture();f.service.workOne=async()=>{throw Error('database unavailable');};
  const result=await f.create();expect(result.notCreated).toEqual({});expect(result.created.subscription).toHaveProperty('id');
 });
});
