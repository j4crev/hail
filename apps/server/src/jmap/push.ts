import {randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import type {SQL} from 'bun';
import type {AccountApiRepository,AccountApiSession} from '../accounts/repository.js';
import type {DiscoveryFetch,NetworkTargetValidator} from '../discovery/verifier.js';
import {withServingGeneration} from '../db/serving.js';
import {JmapError,argumentsOnly,object,jmapAccountId} from './common.js';
import {encryptedPush,validatePushKeys,type PushKeys,type VapidConfig} from './push-crypto.js';

export const HAIL_PUSH='https://haili.app/ns/jmap/push';
type Kind='api'|'passkey'|'provider';
export const credentialKind=(s:AccountApiSession):Kind=>s.authentication?.method??'api';
export type PushStates=(s:AccountApiSession,types:string[])=>Promise<Record<string,string>>;
interface Row {
 id:string;account_id:string;credential_id:string;credential_kind:Kind;generation:number;scopes:string[];
 device_client_id:string;endpoint:string;keys:PushKeys;types:string[];verification_code:string;verified_at:Date|null;
 verification_sent_at:Date|null;created_at:Date;expires_at:Date;attempts:number;last_states:Record<string,string>;lease_token:string;
}
const id=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(v);
const properties=['id','deviceClientId','verificationCode','expires','types'];
const equal=(a:string,b:string)=>a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const scopes=(s:AccountApiSession)=>[...s.scopes].sort();
export class JmapPush {
 constructor(private sql:SQL,private accounts:AccountApiRepository,private origin:string,readonly config:VapidConfig,
   private available:(s:AccountApiSession)=>string[],private states:PushStates,
   private send:DiscoveryFetch,private validate:NetworkTargetValidator){}
 capability(){return {applicationServerKey:this.config.publicKey,contentEncoding:'aes128gcm',maxSubscriptions:4};}
 private authorize(s:AccountApiSession){if(s.migration_state||!this.available(s).length)throw new JmapError('forbidden');}
 private expires(value:unknown){
  if(value!==undefined&&value!==null&&(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.[0-9]*[1-9][0-9]*)?Z$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,19)!==value.slice(0,19)))throw new JmapError('invalidProperties');
  const time=value==null?Date.now()+7*86400_000:Date.parse(value as string);
  if(time<=Date.now())throw new JmapError('invalidProperties');return new Date(Math.floor(Math.min(time,Date.now()+7*86400_000)/1000)*1000);
 }
 private types(s:AccountApiSession,value:unknown){
  const allowed=this.available(s);
  if(value===null||value===undefined)return allowed;
  if(!Array.isArray(value)||value.some(t=>typeof t!=='string'||!allowed.includes(t))||value.length>6||new Set(value).size!==value.length)throw new JmapError('invalidProperties');
  return value as string[];
 }
 async get(s:AccountApiSession,args:Record<string,unknown>){
  this.authorize(s);argumentsOnly(args,['ids','properties']);const ids=args.ids??null,fields=args.properties??properties;
  if(!Array.isArray(fields)||fields.some(p=>typeof p!=='string'))throw new JmapError('invalidArguments');
  if(fields.includes('url')||fields.includes('keys'))throw new JmapError('forbidden');
  if(fields.some(p=>!properties.includes(p))||ids!==null&&(!Array.isArray(ids)||ids.length>50||ids.some(i=>typeof i!=='string')))throw new JmapError('invalidArguments');
  const rows=await this.sql<Row[]>`SELECT * FROM jmap_push_subscriptions WHERE account_id=${s.account_id} AND credential_id=${s.credential_id}
    AND credential_kind=${credentialKind(s)} AND generation=${s.serving_generation??1} AND expires_at>clock_timestamp() ORDER BY id`;
  const selected=rows.filter(r=>ids===null||(ids as string[]).includes(r.id));
  return {list:selected.map(r=>Object.fromEntries(Object.entries({id:r.id,deviceClientId:r.device_client_id,verificationCode:r.verified_at?r.verification_code:null,
    expires:r.expires_at.toISOString().replace('.000Z','Z'),types:r.types}).filter(([k])=>k==='id'||fields.includes(k)))),notFound:ids===null?[]:[...new Set(ids as string[])].filter(i=>!selected.some(r=>r.id===i))};
 }
 async set(s:AccountApiSession,args:Record<string,unknown>){
  this.authorize(s);argumentsOnly(args,['create','update','destroy']);const create=args.create??{},update=args.update??{},destroy=args.destroy??[];
  if(!object(create)||!object(update)||!Array.isArray(destroy)||destroy.some(v=>typeof v!=='string'))throw new JmapError('invalidArguments');
  if(Object.keys(create).length+Object.keys(update).length+destroy.length>50)throw new JmapError('requestTooLarge');
  const created:Record<string,unknown>=Object.create(null),updated:Record<string,unknown>=Object.create(null),notCreated:Record<string,unknown>=Object.create(null),notUpdated:Record<string,unknown>=Object.create(null),notDestroyed:Record<string,unknown>=Object.create(null),destroyed:string[]=[];
  const error=(e:unknown)=>({type:e instanceof JmapError?e.type:'serverFail'});
  for(const [key,value] of Object.entries(create))try{
    if(!/^[A-Za-z0-9_-]{1,255}$/.test(key)||!object(value)||Object.keys(value).some(k=>!['deviceClientId','url','keys','types','expires','verificationCode'].includes(k))||value.verificationCode!=null)throw new JmapError('invalidProperties');
    if(typeof value.deviceClientId!=='string'||!value.deviceClientId.length||value.deviceClientId.length>255||typeof value.url!=='string'||value.url.length>2048)throw new JmapError('invalidProperties');
    let keys:PushKeys;try{const url=new URL(value.url);if(url.port&&url.port!=='443')throw Error();await this.validate(url);keys=validatePushKeys(value.keys);}catch{throw new JmapError('invalidProperties');}
    const types=this.types(s,value.types),expires=this.expires(value.expires),sub=randomUUID(),code=randomBytes(32).toString('base64url');
    await this.sql.begin(async tx=>{
      await tx`SELECT id FROM provider_accounts WHERE id=${s.account_id} FOR UPDATE`;
      await tx`DELETE FROM jmap_push_subscriptions WHERE account_id=${s.account_id} AND (expires_at<=clock_timestamp() OR (verified_at IS NULL AND created_at<clock_timestamp()-interval '15 minutes'))`;
      const rows=await tx<{credential_id:string;device_client_id:string}[]>`SELECT credential_id,device_client_id FROM jmap_push_subscriptions WHERE account_id=${s.account_id}`;
      if(rows.length>=10||rows.filter(r=>r.credential_id===s.credential_id).length>=4)throw new JmapError('overQuota');
      if(rows.some(r=>r.credential_id===s.credential_id&&r.device_client_id===value.deviceClientId))throw new JmapError('invalidProperties');
      const limit=(await tx`INSERT INTO jmap_push_registration_limits(account_id,registrations) VALUES(${s.account_id},1)
        ON CONFLICT(account_id) DO UPDATE SET registrations=CASE WHEN jmap_push_registration_limits.window_start<clock_timestamp()-interval '1 hour' THEN 1 ELSE jmap_push_registration_limits.registrations+1 END,
        window_start=CASE WHEN jmap_push_registration_limits.window_start<clock_timestamp()-interval '1 hour' THEN clock_timestamp() ELSE jmap_push_registration_limits.window_start END RETURNING registrations`)[0]!;
      if(limit.registrations>10)throw new JmapError('overQuota');
      await tx`INSERT INTO jmap_push_subscriptions(id,account_id,credential_id,credential_kind,generation,scopes,device_client_id,endpoint,keys,types,verification_code,expires_at)
        VALUES(${sub},${s.account_id},${s.credential_id},${credentialKind(s)},${s.serving_generation??1},${JSON.stringify(scopes(s))}::text::jsonb,
        ${value.deviceClientId},${value.url},${JSON.stringify(keys)}::text::jsonb,${JSON.stringify(types)}::text::jsonb,${code},${expires})`;
    });
    created[key]={id:sub,expires:expires.toISOString().replace('.000Z','Z')};
    // One verification attempt only; no more endpoint requests until verified.
    await this.workOne(sub).catch(()=>{});
  }catch(e){notCreated[key]=error(e);}
  for(const [key,value] of Object.entries(update))try{
    if(!id(key))throw new JmapError('notFound');
    if(!object(value)||Object.keys(value).some(k=>!['verificationCode','expires','types'].includes(k)))throw new JmapError('invalidProperties');
    await this.sql.begin(async tx=>{
      const row=(await tx<Row[]>`SELECT * FROM jmap_push_subscriptions WHERE id=${key} AND account_id=${s.account_id} AND credential_id=${s.credential_id}
        AND credential_kind=${credentialKind(s)} AND generation=${s.serving_generation??1} AND expires_at>clock_timestamp() FOR UPDATE`)[0];
      if(!row)throw new JmapError('notFound');
      if(value.verificationCode!==undefined&&(typeof value.verificationCode!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value.verificationCode)||!equal(value.verificationCode,row.verification_code)))throw new JmapError('invalidProperties');
      const types=value.types===undefined?row.types:this.types(s,value.types),expires=value.expires===undefined?row.expires_at:this.expires(value.expires);
      const verifying=!row.verified_at&&value.verificationCode!==undefined;
      const baseline=verifying?await this.states(s,types):row.last_states;
      await tx`UPDATE jmap_push_subscriptions SET types=${JSON.stringify(types)}::text::jsonb,expires_at=${expires},
        verified_at=CASE WHEN ${verifying} THEN clock_timestamp() ELSE verified_at END,last_states=${JSON.stringify(baseline)}::text::jsonb,
        next_attempt_at=clock_timestamp(),attempts=0,lease_token=NULL,lease_until=NULL WHERE id=${key}`;
      updated[key]={expires:expires.toISOString().replace('.000Z','Z')};
    });
  }catch(e){notUpdated[key]=error(e);}
  for(const key of new Set(destroy))try{
    if(!id(key))throw new JmapError('notFound');
    const removed=await this.sql`DELETE FROM jmap_push_subscriptions WHERE id=${key} AND account_id=${s.account_id} AND credential_id=${s.credential_id} AND credential_kind=${credentialKind(s)} RETURNING id`;
    if(!removed.length)throw new JmapError('notFound');destroyed.push(key);
  }catch(e){notDestroyed[key]=error(e);}
  return {created,updated,destroyed,notCreated,notUpdated,notDestroyed};
 }
 async workOne(onlyId?:string):Promise<boolean>{
  await this.sql`DELETE FROM jmap_push_subscriptions WHERE id IN (SELECT id FROM jmap_push_subscriptions
    WHERE expires_at<=clock_timestamp() OR (verified_at IS NULL AND created_at<clock_timestamp()-interval '15 minutes') LIMIT 500)`;
  const lease=randomUUID();
  const row=(await this.sql<Row[]>`UPDATE jmap_push_subscriptions SET lease_token=${lease},lease_until=clock_timestamp()+interval '60 seconds'
    WHERE id=(SELECT id FROM jmap_push_subscriptions WHERE next_attempt_at<=clock_timestamp() AND (lease_until IS NULL OR lease_until<clock_timestamp())
      AND (${onlyId??null}::uuid IS NULL OR id=${onlyId??null}::uuid) ORDER BY next_attempt_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`)[0];
  if(!row)return false;
  const remove=()=>this.sql`DELETE FROM jmap_push_subscriptions WHERE id=${row.id} AND lease_token=${lease}`;
  try{
    const session=await this.accounts.authenticateReference(row.credential_kind,row.credential_id);
    if(!session||session.migration_state||session.account_id!==row.account_id||(session.serving_generation??1)!==Number(row.generation)||JSON.stringify(scopes(session))!==JSON.stringify(row.scopes)){
      await remove();return true;
    }
    if(!row.verified_at&&row.verification_sent_at){await this.defer(row.id,lease,30);return true;}
    const states=row.verified_at?await withServingGeneration(session.account_id,session.serving_generation??1,()=>this.states(session,row.types)):null;
    if(states&&(!Object.keys(states).length||Object.keys(states).length===Object.keys(row.last_states).length&&Object.entries(states).every(([type,state])=>row.last_states[type]===state))){await this.defer(row.id,lease,30);return true;}
    if(!row.verified_at)await this.sql`UPDATE jmap_push_subscriptions SET verification_sent_at=clock_timestamp() WHERE id=${row.id} AND lease_token=${lease}`;
    const payload=states?{'@type':'StateChange',changed:{[jmapAccountId(this.origin,session)]:states}}:
      {'@type':'PushVerification',pushSubscriptionId:row.id,verificationCode:row.verification_code};
    const request=encryptedPush(row.endpoint,row.keys,payload,this.config,Math.max(0,Math.min(300,Math.floor((row.expires_at.getTime()-Date.now())/1000))));
    // Check the lease still exists after state reads; cancellation wins before dispatch.
    if(!(await this.sql`SELECT id FROM jmap_push_subscriptions WHERE id=${row.id} AND lease_token=${lease} AND expires_at>clock_timestamp()`).length)return true;
    const response=await this.send(request);await response.body?.cancel();
    if(response.status===404||response.status===410){await remove();return true;}
    if(response.ok){
      await this.sql`UPDATE jmap_push_subscriptions SET last_states=${JSON.stringify(states??{})}::text::jsonb,attempts=0,lease_until=NULL,lease_token=NULL,
        next_attempt_at=clock_timestamp()+interval '30 seconds' WHERE id=${row.id} AND lease_token=${lease}`;
    }else if(!row.verified_at){await this.defer(row.id,lease,30);}
    else if(response.status===429||response.status>=500){
      const retry=response.headers.get('Retry-After');const seconds=retry?(/^\d+$/.test(retry)?Number(retry):Math.ceil((Date.parse(retry)-Date.now())/1000)):0;
      await this.retry(row,lease,Number.isFinite(seconds)?seconds:0);
    }else await remove();
  }catch{await this.retry(row,lease);}
  return true;
 }
 private defer(id:string,lease:string,seconds:number){return this.sql`UPDATE jmap_push_subscriptions SET lease_until=NULL,lease_token=NULL,
   next_attempt_at=clock_timestamp()+(${seconds}::double precision*interval '1 second') WHERE id=${id} AND lease_token=${lease}`;}
 private async retry(row:Row,lease:string,retryAfter=0){
  if(row.attempts>=5){await this.sql`DELETE FROM jmap_push_subscriptions WHERE id=${row.id} AND lease_token=${lease}`;return;}
  const delay=Math.min(3600,Math.max(retryAfter,30*2**row.attempts));
  await this.sql`UPDATE jmap_push_subscriptions SET attempts=attempts+1,lease_until=NULL,lease_token=NULL,
    next_attempt_at=clock_timestamp()+(${delay}::double precision*interval '1 second') WHERE id=${row.id} AND lease_token=${lease}`;
 }
}
