/**
 * The email bridge's converter process. It parses untrusted mail and fetches
 * sender-chosen image URLs, so it runs apart from the provider: its own
 * container, no keys, and a database role limited to the intake queue.
 *
 * Environment: EMAIL_BRIDGE_CONVERTER_DATABASE_URL (that limited role).
 */
import { SQL } from "bun";
import { EmailBridgeConverter } from "../bridge/converter.js";
import { createDkimCheck } from "../bridge/dkim.js";
import { createImageResolver } from "../bridge/image-fetcher.js";
import { SafeHttpsTransport } from "../discovery/safe-fetch.js";

const url = process.env.EMAIL_BRIDGE_CONVERTER_DATABASE_URL;
if (!url) throw new Error("EMAIL_BRIDGE_CONVERTER_DATABASE_URL is required");
// The converter must never share the provider's database role, which can read keys.
const role = new URL(url);
if (!role.password || !role.username || role.username === "hail" || role.username === "postgres") {
  throw new Error("EMAIL_BRIDGE_CONVERTER_DATABASE_URL must name the converter's own limited role and its password");
}
const sql = new SQL(url, { max: 2 });
const converter = new EmailBridgeConverter(sql, {
  resolveRemote: createImageResolver(new SafeHttpsTransport().fetchImage),
  checkDkim: createDkimCheck(),
});

let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { stopping = true; });
console.info(JSON.stringify({ level: "info", message: "email bridge converter started" }));
while (!stopping) {
  let worked = false;
  try { worked = await converter.workOne(); }
  catch (error) {
    console.error(JSON.stringify({ level: "error", message: "email bridge conversion failed", error: error instanceof Error ? error.message : "unknown error" }));
  }
  if (!worked) await Bun.sleep(2_000);
}
await sql.close();
console.info(JSON.stringify({ level: "info", message: "email bridge converter stopped" }));
