import { MonitorDatabase } from "../database.js";
import { EnrollmentProviders } from "../providers.js";

const [action, first, second, output] = Bun.argv.slice(2);
const usage = "Usage: monitor:providers list | create PROVIDER_ORIGIN ALERT_ORIGIN PRIVATE_OUTPUT | rotate ID PRIVATE_OUTPUT | disable ID | enable ID | import-legacy";
if (!Bun.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
if (!["list", "create", "rotate", "disable", "enable", "import-legacy"].includes(action ?? "")) throw new Error(usage);
const db = new MonitorDatabase(Bun.env.DATABASE_URL);
try {
  await db.migrate();
  const providers = new EnrollmentProviders(db.sql);
  if (action === "list") {
    console.info(JSON.stringify(await db.sql`SELECT id,provider_origin,alert_origin,enabled,
      requests_per_minute,max_identities,enrollments_per_day FROM monitor_enrollment_providers ORDER BY provider_origin`));
  } else if (action === "disable" || action === "enable") {
    if (!first || second) throw new Error(usage);
    await providers.setEnabled(first, action === "enable");
    console.info(JSON.stringify({ id: first, enabled: action === "enable" }));
  } else if (action === "import-legacy") {
    if (first) throw new Error(usage);
    const origin = Bun.env.MONITOR_ENROLLMENT_PROVIDER, alerts = Bun.env.MONITOR_ENROLLMENT_ALERT_ORIGIN,
      token = Bun.env.MONITOR_ENROLLMENT_TOKEN;
    if (!origin || !alerts || !token) throw new Error("Import requires the existing three MONITOR_ENROLLMENT settings");
    // Explicit operator migration, never automatic public claiming by origin.
    const { canonicalOrigin } = await import("../providers.js");
    const { hash } = await import("../http.js");
    const { decodeBase64Url } = await import("@racrproto/codec/base64url");
    canonicalOrigin(origin); canonicalOrigin(alerts); decodeBase64Url(token, 32);
    await db.sql.begin(async tx => {
      await tx`SELECT pg_advisory_xact_lock(686169156)`;
      const tokenHash = await hash(token);
      await tx`INSERT INTO monitor_enrollment_providers(id,provider_origin,alert_origin,token_hash)
        VALUES (${crypto.randomUUID()},${origin},${alerts},${tokenHash}) ON CONFLICT (provider_origin) DO NOTHING`;
      const row = (await tx`SELECT * FROM monitor_enrollment_providers WHERE provider_origin=${origin} FOR UPDATE`)[0]!;
      if (row.alert_origin !== alerts || row.token_hash !== tokenHash) throw new Error("Existing provider differs; review configuration");
      // PostgreSQL historical JSONB values may contain an encoded JSON string.
      const rows = await tx`SELECT w.did,b.reviewed_state FROM monitored_dids w
        JOIN monitor_bootstrap_checkpoints b ON b.did=w.did
        WHERE w.enrollment_provider_id IS NULL AND w.alert_webhook_url=${alerts + "/hail/signup"} FOR UPDATE OF w`;
      let adopted = 0;
      for (const item of rows) {
        let state = item.reviewed_state;
        while (typeof state === "string") state = JSON.parse(state);
        if (state?.services?.hail?.endpoint !== origin + "/hail") continue;
        await tx`UPDATE monitored_dids SET enrollment_provider_id=${row.id} WHERE did=${item.did}`;
        adopted++;
      }
      console.info(JSON.stringify({ id: row.id, providerOrigin: origin, adopted, preservedMonitoring: true }));
    });
  } else {
    const path = action === "create" ? output : second;
    if (!first || !path || action === "create" && !second || action === "rotate" && output) throw new Error(usage);
    // Reserve a private, new file before creating or rotating a credential.
    const handle = await import("node:fs/promises").then(fs => fs.open(path, "wx", 0o600));
    try {
      const result = action === "create" ? await providers.create(first, second!) : await providers.rotate(first);
      await handle.writeFile(JSON.stringify(result) + "\n"); await handle.sync();
      console.info(JSON.stringify({ id: result.id, credentialFile: path }));
    } finally { await handle.close(); }
  }
} finally { await db.close(); }
