// Provider registration v2 (spec/monitor-receiver.md):
//   prepare  → write the private request and the public verification document
//   request  → monitor checks the document(s) and emails the operator a code
//   finish   → submit the code; receive both credentials
import { open, readFile, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { registrationDocument, REGISTRATION_PATH } from "../provider-registration.js";
import { PinnedHttpsClient } from "../public-http.js";
import { boundedBody } from "../http.js";
import { emailAddress } from "../receiver-provider-wire.js";

const usage = "Usage: monitor:register-provider prepare MONITOR_API_ORIGIN PROVIDER_ORIGIN WEB_ORIGIN|- OPERATOR_EMAIL PRIVATE_FILE PUBLIC_FILE" +
  " | request PRIVATE_FILE [--resend] | finish PRIVATE_FILE CODE CREDENTIAL_FILE";
const [action, ...args] = Bun.argv.slice(2);

async function save(path: string, value: unknown, mode: number) {
  const file = await open(path, "wx", mode);
  try { await file.writeFile(JSON.stringify(value, null, 2) + "\n"); await file.sync(); }
  finally { await file.close(); }
}
async function privateInput(path: string) {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > 4096 || metadata.mode & 0o077) throw new Error("Use the private registration file");
  let input;
  try { input = JSON.parse(await readFile(path, "utf8")); } catch { throw new Error("Invalid private registration file"); }
  await registrationDocument(input);
  if (!emailAddress(input.operatorEmail)) throw new Error("Invalid private registration file");
  return input;
}
async function submit(input: Record<string, unknown>, extra: Record<string, unknown>) {
  const { monitorApiOrigin, ...body } = input;
  const response = await new PinnedHttpsClient().post(monitorApiOrigin + "/api/v1/providers/register",
    new TextEncoder().encode(JSON.stringify({ ...body, ...extra })), { "Content-Type": "application/json" });
  const bytes = await boundedBody(response, 4096);
  let result: Record<string, unknown> = {};
  try { result = JSON.parse(new TextDecoder().decode(bytes ?? new Uint8Array())); } catch { /* reported below */ }
  return { status: response.status, result };
}

if (action === "prepare" && args.length === 6) {
  const [monitorApiOrigin, providerOrigin, webOrigin, operatorEmail, privateFile, publicFile] = args as [string, string, string, string, string, string];
  const email = emailAddress(operatorEmail);
  if (!email) throw new Error("Invalid operator email");
  const input = { monitorApiOrigin, providerOrigin, ...(webOrigin === "-" ? {} : { webOrigin }), operatorEmail: email,
    registrationSecret: randomBytes(32).toString("base64url"), expiresAt: Math.floor(Date.now() / 1000) + 3600 };
  const document = await registrationDocument(input);
  await save(privateFile, input, 0o600);
  await save(publicFile, document, 0o644);
  console.info(JSON.stringify({ publish: [providerOrigin, ...(input.webOrigin ? [input.webOrigin] : [])].map(origin => origin + REGISTRATION_PATH),
    publicFile, expiresAt: new Date(input.expiresAt * 1000).toISOString() }));
} else if (action === "request" && (args.length === 1 || args.length === 2 && args[1] === "--resend")) {
  const input = await privateInput(args[0]!);
  const { status, result } = await submit(input, args[1] ? { resend: true } : {});
  if (status !== 202) throw new Error(`Registration returned HTTP ${status}: ${String(result.error ?? "check document expiry and every HTTPS endpoint")}`);
  console.info(JSON.stringify({ codeSentTo: input.operatorEmail, expiresAt: new Date(Number(result.expiresAt) * 1000).toISOString() }));
} else if (action === "finish" && args.length === 3) {
  const [privateFile, code, outputFile] = args as [string, string, string];
  if (!/^\d{8}$/.test(code)) throw new Error("The code has eight digits");
  const input = await privateInput(privateFile);
  // Reserve the credential file before the request. After a network failure, retry
  // with the same private file and code to a new output filename.
  const output = await open(outputFile, "wx", 0o600);
  try {
    const { status, result } = await submit(input, { operatorCode: code });
    if (status !== 200) throw new Error(`Registration returned HTTP ${status}: ${String(result.error ?? "retry")}`);
    if (result.apiOrigin !== input.monitorApiOrigin || result.providerOrigin !== input.providerOrigin ||
      typeof result.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(result.token) ||
      typeof result.receiverToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(result.receiverToken) ||
      typeof result.receiverOrigin !== "string" || typeof result.monitorPublicKey !== "string" || !result.monitorPublicKey.startsWith("did:key:"))
      throw new Error("Invalid registration response");
    await output.writeFile(JSON.stringify(result, null, 2) + "\n"); await output.sync();
    console.info(JSON.stringify({ providerId: result.providerId, credentialFile: outputFile,
      monitorPublicKey: result.monitorPublicKey, removeVerificationDocuments: true }));
  } finally { await output.close(); }
} else {
  throw new Error(usage);
}
