import { SQL } from "bun";
import { expect,it } from "vitest";
import { handoffAccountMonitor } from "../src/accounts/monitor-handoff.js";

it.skipIf(!process.env.DATABASE_URL)("retries a lost handoff response and fences stale serving generations",async()=>{
  // Minimal durable activation/outbox fixtures isolate the worker's retry and
  // generation rules; public activation evidence is exercised by transfer suites.
  const sql=new SQL(process.env.DATABASE_URL!);
  try{
    await sql`CREATE TABLE provider_accounts(id uuid PRIMARY KEY,did text,activated_at timestamptz,closed_at timestamptz)`;
    await sql`CREATE TABLE account_serving_generations(account_id uuid PRIMARY KEY,generation bigint)`;
    await sql`CREATE TABLE pending_migration_imports(transfer_id uuid PRIMARY KEY,did text,state text,activated_at timestamptz)`;
    await sql`CREATE TABLE public_cutover_evidence_selection(transfer_id uuid,evidence_digest bytea,activated_at timestamptz)`;
    await sql`CREATE TABLE public_cutover_evidence(transfer_id uuid,evidence_digest bytea,operation_cid text)`;
    // Exercise the actual migration's table definitions without genesis backfill dependencies.
    const migration=await Bun.file(new URL("../migrations/0108_monitor_handoff.sql",import.meta.url)).text();
    await sql.unsafe(migration.slice(0,migration.indexOf("INSERT INTO account_monitor_bindings")));
    await sql.unsafe(migration.slice(migration.indexOf("CREATE TABLE account_monitor_handoffs")));
    const account=crypto.randomUUID(),transfer=crypto.randomUUID(),did="did:plc:"+"a".repeat(24),now=new Date();
    await sql`INSERT INTO provider_accounts VALUES (${account},${did},${now},NULL)`;
    await sql`INSERT INTO account_serving_generations VALUES (${account},2)`;
    await sql`INSERT INTO pending_migration_imports VALUES (${transfer},${did},'active',${now})`;
    await sql`INSERT INTO account_monitor_handoffs(transfer_id,account_id,serving_generation,did,operation_cid,monitor_public_key)
      VALUES (${transfer},${account},2,${did},'new-cid','pinned-key')`;
    let loseReply=true,calls=0;
    const monitor={publicKey:"pinned-key",async handoff(identity:string,cid:string,id:string){
      expect([identity,cid,id]).toEqual([did,"new-cid",transfer]);calls++;
      if(loseReply){loseReply=false;throw Error("Lost committed response");}return true;
    }};
    expect(await handoffAccountMonitor(sql,monitor)).toBe("retry");
    expect(await sql`SELECT * FROM account_monitor_bindings`).toHaveLength(0);
    await sql`UPDATE account_monitor_handoffs SET next_attempt_at=clock_timestamp()`;
    expect(await handoffAccountMonitor(sql,monitor)).toBe("managed");
    expect((await sql`SELECT operation_cid,serving_generation::integer FROM account_monitor_bindings`)[0]).toMatchObject({operation_cid:"new-cid",serving_generation:2});
    expect(await handoffAccountMonitor(sql,monitor)).toBe("idle");expect(calls).toBe(2);
    await sql`UPDATE account_monitor_handoffs SET completed_at=NULL,outcome=NULL`;
    await sql`UPDATE account_serving_generations SET generation=3`;
    expect(await handoffAccountMonitor(sql,monitor)).toBe("superseded");expect(calls).toBe(2);
    expect((await sql`SELECT operation_cid FROM account_monitor_bindings`)[0]!.operation_cid).toBe("new-cid");
  }finally{await sql.close();}
});
