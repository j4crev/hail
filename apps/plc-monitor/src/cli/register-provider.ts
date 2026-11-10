import { open, readFile, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { registrationDocument, REGISTRATION_PATH } from "../provider-registration.js";
import { PinnedHttpsClient } from "../public-http.js";
import { boundedBody } from "../http.js";

const [action, ...args] = Bun.argv.slice(2);
async function save(path: string, value: unknown, mode: number) {
  const file = await open(path, "wx", mode);
  try { await file.writeFile(JSON.stringify(value, null, 2) + "\n"); await file.sync(); }
  finally { await file.close(); }
}
if (action === "prepare" && args.length === 5) {
  const [monitorApiOrigin, providerOrigin, alertOrigin, privateFile, publicFile] = args as [string, string, string, string, string];
  const input = { monitorApiOrigin, providerOrigin, alertOrigin, registrationSecret: randomBytes(32).toString("base64url"),
    expiresAt: Math.floor(Date.now() / 1000) + 3600 };
  const document = await registrationDocument(input);
  await save(privateFile, input, 0o600);
  await save(publicFile, document, 0o644);
  console.info(JSON.stringify({ publish: [...new Set([providerOrigin, alertOrigin])].map(origin => origin + REGISTRATION_PATH),
    publicFile, expiresAt: new Date(input.expiresAt * 1000).toISOString() }));
} else if (action === "finish" && args.length === 2) {
  const [privateFile, outputFile] = args as [string, string];
  const metadata = await stat(privateFile);
  if (!metadata.isFile() || metadata.size > 4096 || metadata.mode & 0o077) throw new Error("Use the private registration file");
  let input;
  try { input = JSON.parse(await readFile(privateFile, "utf8")); }
  catch { throw new Error("Invalid private registration file"); }
  await registrationDocument(input);
  const { monitorApiOrigin, ...body } = input;
  // Reserve the credential file before making the request. On network failure
  // the same private registration file may retry to a new output filename.
  const output = await open(outputFile, "wx", 0o600);
  try {
    const response = await new PinnedHttpsClient().post(monitorApiOrigin + "/api/v1/providers/register",
      new TextEncoder().encode(JSON.stringify(body)), {});
    if (response.status !== 200) throw new Error(`Registration returned HTTP ${response.status}; check document expiry and both HTTPS endpoints`);
    const bytes = await boundedBody(response, 4096);
    if (!bytes) throw new Error("Invalid registration response");
    let result;
    try { result = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw new Error("Invalid registration response"); }
    if (result.apiOrigin !== monitorApiOrigin || result.providerOrigin !== input.providerOrigin ||
      result.alertOrigin !== input.alertOrigin || !/^[A-Za-z0-9_-]{43}$/.test(result.token) ||
      typeof result.monitorPublicKey !== "string" || !result.monitorPublicKey.startsWith("did:key:"))
      throw new Error("Invalid registration response");
    await output.writeFile(JSON.stringify(result, null, 2) + "\n"); await output.sync();
    console.info(JSON.stringify({ providerId: result.providerId, credentialFile: outputFile,
      monitorPublicKey: result.monitorPublicKey, removeVerificationDocuments: true }));
  } finally { await output.close(); }
} else {
  throw new Error("Usage: monitor:register-provider prepare MONITOR_ORIGIN PROVIDER_ORIGIN ALERT_ORIGIN PRIVATE_FILE PUBLIC_FILE | finish PRIVATE_FILE CREDENTIAL_FILE");
}
