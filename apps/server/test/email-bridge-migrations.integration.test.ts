import { randomBytes, randomUUID } from "node:crypto";
import { SQL } from "bun";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ProviderDatabase } from "../src/db/database.js";

const integration = process.env.DATABASE_URL ? it : it.skip;
let admin: SQL, db: ProviderDatabase, schema: string;
beforeAll(async () => {
  if (!process.env.DATABASE_URL) return;
  admin = new SQL(process.env.DATABASE_URL); schema = `bridge_rollback_${randomUUID().replaceAll("-", "")}`;
  await admin.unsafe(`CREATE SCHEMA "${schema}"`);
  const url = new URL(process.env.DATABASE_URL); url.searchParams.set("options", `-csearch_path=${schema}`);
  db = new ProviderDatabase(url.toString()); await db.migrate();
});
afterAll(async () => {
  if (db) await db.close();
  if (admin) { if (schema) await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`); await admin.close(); }
});
/** Rollback scripts manage their own transaction, which needs a dedicated connection. */
async function rollback(name: string): Promise<void> {
  const connection = await db.sql.reserve();
  try { await connection.unsafe(await Bun.file(new URL(`../migrations/rollback/${name}.sql`, import.meta.url)).text()); }
  catch (error) { await connection.unsafe("ROLLBACK").catch(() => {}); throw error; }
  finally { connection.release(); }
}

integration("rolls the email bridge migrations back in order, refusing to lose user data, and reapplies them", async () => {
  const account = randomUUID();
  await db.sql`INSERT INTO provider_accounts(id,tenant_id,canonical_address,did,onboarding_state,activated_at,activation_binding_digest,activation_verification_mode)
    VALUES(${account},${randomUUID()},${account + "@p.example"},${"did:plc:" + "b".repeat(24)},'active',now(),${randomBytes(32)},'public')`;
  await db.sql`INSERT INTO email_bridge_aliases (id, account_id, local_part, label) VALUES (${randomUUID()}, ${account}, 'abcdefghijkl', 'x')`;
  const large = randomUUID();
  await db.sql`INSERT INTO account_message_drafts(account_id,id,content) VALUES(${account},${large},${JSON.stringify({ text: "x".repeat(500_000) })}::text::jsonb)`;

  await rollback("0124_jmap_state_notifications");
  await rollback("0123_reserve_email_role");
  expect(await db.sql`SELECT 1 FROM provider_reserved_names WHERE local_part = 'email'`).toHaveLength(0);
  await rollback("0122_email_bridge_delivery");
  await expect(rollback("0121_draft_content_limit")).rejects.toThrow("would be lost");
  await db.sql`DELETE FROM account_message_drafts WHERE id = ${large}`;
  await rollback("0121_draft_content_limit");
  await expect(db.sql`INSERT INTO account_message_drafts(account_id,id,content) VALUES(${account},${randomUUID()},${JSON.stringify({ text: "x".repeat(450_000) })}::text::jsonb)`)
    .rejects.toThrow();
  await expect(rollback("0120_email_bridge")).rejects.toThrow("after users created aliases");
  await db.sql`DELETE FROM email_bridge_aliases`;
  await rollback("0120_email_bridge");
  expect((await db.sql<{ version: number }[]>`SELECT max(version)::integer AS version FROM schema_migrations`)[0]!.version).toBe(119);

  await db.migrate();
  expect(await db.sql`SELECT 1 FROM provider_reserved_names WHERE local_part = 'email'`).toHaveLength(1);
  expect(await db.sql`SELECT message_id FROM email_bridge_intake LIMIT 0`).toHaveLength(0);
});
