import { generateKeyPairSync } from "node:crypto";
import { cidForCbor } from "@atproto/common";
import { P256Keypair } from "@atproto/crypto";
import { didForCreateOp, signOperation, validateOperationLog } from "@did-plc/lib";
import { expect, it } from "vitest";
import { MonitorDatabase } from "../src/database.js";
import { PlcMonitor } from "../src/monitor.js";
import { MonitorNotifier } from "../src/notifier.js";
import { MonitorSigner } from "../src/signing.js";

it.skipIf(!process.env.DATABASE_URL)("stops only matching managed enrollments and blocks polling, pending alerts, attestations and replay", async () => {
  const db = new MonitorDatabase(process.env.DATABASE_URL!);
  try {
    await db.migrate();
    const key = await P256Keypair.create(), provider = "https://provider.example.com", webhook = "https://alerts.example.com/hail/signup";
    const operation = await signOperation({ type: "plc_operation", prev: null, rotationKeys: [key.did()], verificationMethods: {},
      services: { hail: { type: "HailMessaging", endpoint: `${provider}/hail` } }, alsoKnownAs: [] }, key);
    const did = await didForCreateOp(operation), cid = (await cidForCbor(operation)).toString(), state = (await validateOperationLog(did, [operation]))!;
    let reads = 0;
    const monitor = new PlcMonitor(db.sql, {
      async getAuditableLog() { reads++; return [{ did, operation, cid, nullified: false, createdAt: new Date().toISOString() }]; },
      async getOperationLog() { return [operation]; }, async getDocumentData() { return state; }, async exportAfter() { return []; },
    });
    await monitor.enroll(did, cid, webhook, state);
    for (const [expected, origin, destination] of [["bad", provider, webhook], [cid, "https://other.example.com", webhook], [cid, provider, "https://owner.example.com/alerts"]])
      await expect(monitor.stopManaged(did, expected!, origin!, destination!)).rejects.toThrow("does not match");
    expect((await db.sql`SELECT stopped_at FROM monitored_dids WHERE did=${did}`)[0]!.stopped_at).toBeNull();
    expect(await db.sql`SELECT id FROM monitor_alerts WHERE did=${did} AND sent_at IS NULL`).toHaveLength(1);
    await monitor.stopManaged(did, cid, provider, webhook);
    const stopped = (await db.sql`SELECT stopped_at FROM monitored_dids WHERE did=${did}`)[0]!.stopped_at;
    await monitor.stopManaged(did, cid, provider, webhook);
    expect((await db.sql`SELECT stopped_at FROM monitored_dids WHERE did=${did}`)[0]!.stopped_at).toEqual(stopped);
    const before = reads;
    expect(await monitor.poll()).toMatchObject({ inspected: 0, alerts: 0 });
    expect(reads).toBe(before);
    const signer = new MonitorSigner(generateKeyPairSync("ed25519").privateKey);
    expect(await new MonitorNotifier(db.sql, signer, { async send() { throw new Error("Must not send"); } }).sendOne()).toBe("idle");
    await expect(monitor.attest(did, crypto.randomUUID(), cid, "https://monitor.example.com", signer)).rejects.toThrow();
    await expect(monitor.attestOnboarding(did, cid, "https://monitor.example.com", signer)).rejects.toThrow();
    await expect(monitor.enroll(did, cid, webhook, state)).rejects.toThrow("stopped");
  } finally { await db.close(); }
});
