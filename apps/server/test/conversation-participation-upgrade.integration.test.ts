import {readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {ProviderDatabase} from '../src/db/database.js';
import {sharedConversationFixture} from './support/shared-conversation-fixture.js';
import {EnvelopeService} from '../src/envelopes/service.js';
import {EnvelopeRepository} from '../src/envelopes/repository.js';
import {OnboardingRepository} from '../src/onboarding/repository.js';
import {GrantRepository} from '../src/grants/repository.js';
import {uuidV7} from '../src/identity/uuid-v7.js';

it.skipIf(!process.env.DATABASE_URL)('upgrades existing participation without extending deadlines or retaining revival authority',async()=>{
  const db=new ProviderDatabase(process.env.DATABASE_URL!);
  try{
    await db.sql`CREATE TABLE schema_migrations(version integer PRIMARY KEY,name text NOT NULL,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`;
    const directory=new URL('../migrations/',import.meta.url);
    for(const file of (await readdir(directory)).filter(f=>/^\d{4}_.*\.sql$/.test(f)&&Number(f.slice(0,4))<107).sort()){
      const source=await Bun.file(new URL(file,directory)).text();
      await db.sql.begin(async tx=>{
        await tx.unsafe(source);
        await tx`INSERT INTO schema_migrations(version,name,checksum) VALUES(${Number(file.slice(0,4))},${file.slice(5,-4)},${createHash('sha256').update(source).digest('hex')})`;
      });
    }
    const {a,b,c,origin,encryptor,resolver,authority}=await sharedConversationFixture(db.sql);
    const envelopes=new EnvelopeRepository(db.sql);
    const service=new EnvelopeService(new OnboardingRepository(db.sql),new GrantRepository(db.sql),envelopes,encryptor,resolver,origin+'/hail',undefined,authority);
    const id=uuidV7();
    await service.ensureConversation(a.did,id,[a.did,b.did,c.did]);
    await db.sql`UPDATE conversation_memberships SET admitted_at=clock_timestamp()-interval '100 days',
      last_activity_at=clock_timestamp()-interval '20 days' WHERE account_id=${a.id}`;
    await db.sql`INSERT INTO conversation_memberships(account_id,creator_did,conversation_id,state,admitted_at,expires_at)
      VALUES(${b.id},${a.did},${id},'active',clock_timestamp()-interval '100 days',clock_timestamp()-interval '30 days')`;
    await db.sql`INSERT INTO conversation_memberships(account_id,creator_did,conversation_id,state,admitted_at,left_at)
      VALUES(${c.id},${a.did},${id},'left',clock_timestamp()-interval '100 days',clock_timestamp())`;
    await db.sql`INSERT INTO conversation_revival_receipts(account_id,creator_did,conversation_id,request_id,request_hash,expires_at,outcome)
      VALUES(${b.id},${a.did},${id},${uuidV7()},${new Uint8Array(32)},clock_timestamp()+interval '1 day','renewed')`;
    const prior=await db.sql<{account_id:string;expires_at:Date}[]>`SELECT account_id,expires_at FROM conversation_memberships`;
    await db.migrate();
    const rows=await db.sql<{account_id:string;state:string;admitted_at:Date;last_activity_at:Date|null;expires_at:Date}[]>`SELECT * FROM conversation_memberships`;
    expect(rows).toHaveLength(3);
    for(const row of rows){
      expect(row.expires_at.getTime()).toBeLessThanOrEqual(prior.find(p=>p.account_id===row.account_id)!.expires_at.getTime());
      expect(row.expires_at.getTime()).toBe(Math.min(prior.find(p=>p.account_id===row.account_id)!.expires_at.getTime(),(row.last_activity_at??row.admitted_at).getTime()+90*86400000));
    }
    expect(rows.find(r=>r.account_id===c.id)!.state).toBe('left');
    expect(rows.find(r=>r.account_id===b.id)!.expires_at.getTime()).toBeLessThan(Date.now());
    expect((await db.sql`SELECT 1 FROM conversation_descriptors WHERE conversation_id=${id}`).length).toBe(1);
    expect((await db.sql<{name:string|null}[]>`SELECT to_regclass('conversation_revival_receipts') AS name`)[0]!.name).toBeNull();
    expect((await db.sql`SELECT 1 FROM pg_trigger WHERE tgname IN ('conversation_revival_before_fence','conversation_revival_before_generation')`).length).toBe(0);
    await expect(db.sql.begin(async tx=>tx.unsafe(await Bun.file(new URL('../migrations/rollback/0107_conversation_participation.sql',import.meta.url)).text()))).rejects.toThrow('restore a pre-upgrade backup');
  }finally{await db.close();}
},60_000);
