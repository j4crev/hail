import {randomBytes,randomUUID} from 'node:crypto';
import {SQL} from 'bun';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {ProviderDatabase} from '../src/db/database.js';
import {STATE_CHANNEL,StateNotifications} from '../src/jmap/state-notifications.js';

const integration=process.env.DATABASE_URL?it:it.skip;
let admin:SQL,db:ProviderDatabase,schema:string,listener:SQL;
beforeAll(async()=>{
  if(!process.env.DATABASE_URL)return;
  admin=new SQL(process.env.DATABASE_URL);schema=`notify_${randomUUID().replaceAll('-','')}`;
  await admin.unsafe(`CREATE SCHEMA "${schema}"`);
  const url=new URL(process.env.DATABASE_URL);url.searchParams.set('options',`-csearch_path=${schema}`);
  db=new ProviderDatabase(url.toString());await db.migrate();listener=new SQL(url.toString(),{max:1});
});
afterAll(async()=>{
  await listener?.close();if(db)await db.close();
  if(admin){if(schema)await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);await admin.close();}
});
const until=async(check:()=>boolean)=>{for(let i=0;i<100&&!check();i++)await Bun.sleep(20);return check();};

integration('wakes only the changed account, on commit, and reports a working listener',async()=>{
  const account=randomUUID(),other=randomUUID();
  for(const id of [account,other])await db.sql`INSERT INTO provider_accounts(id,tenant_id,canonical_address,did,onboarding_state,activated_at,activation_binding_digest,activation_verification_mode)
    VALUES(${id},${randomUUID()},${id+'@p.example'},${'did:plc:'+randomBytes(15).toString('hex').replace(/[^a-z2-7]/g,'a').slice(0,24).padEnd(24,'a')},'active',now(),${randomBytes(32)},'public')`;
  const notifications=new StateNotifications((channel,onNotify,onListen)=>listener.listen(channel,onNotify,onListen),
    (channel,payload)=>listener`SELECT pg_notify(${channel},${payload})`,60_000,2_000);
  await notifications.start();
  expect(await until(()=>notifications.healthy)).toBe(true);
  let woken=0,otherWoken=0;
  const unwatch=notifications.watch(account,()=>woken++);notifications.watch(other,()=>otherWoken++);
  const state=async(id:string)=>db.sql`INSERT INTO jmap_message_states(account_id,generation,revision) VALUES(${id},1,1)
    ON CONFLICT (account_id,generation) DO UPDATE SET revision=jmap_message_states.revision+1`;
  // Nothing is announced for a change that rolls back.
  await db.sql.begin(async tx=>{await tx`INSERT INTO jmap_message_states(account_id,generation,revision) VALUES(${account},1,1) ON CONFLICT DO NOTHING`;throw new Error('abort');}).catch(()=>{});
  await Bun.sleep(200);expect(woken).toBe(0);
  await state(account);expect(await until(()=>woken===1)).toBe(true);expect(otherWoken).toBe(0);
  await db.sql`INSERT INTO jmap_collection_states(account_id,generation,collection,revision) VALUES(${account},1,'HailGrant',1)
    ON CONFLICT (account_id,generation,collection) DO UPDATE SET revision=jmap_collection_states.revision+1`;
  expect(await until(()=>woken===2)).toBe(true);
  unwatch();await state(account);await Bun.sleep(200);expect(woken).toBe(2);
  await notifications.stop();expect(notifications.healthy).toBe(false);
  expect(STATE_CHANNEL).toBe('hail_jmap_state');
});
