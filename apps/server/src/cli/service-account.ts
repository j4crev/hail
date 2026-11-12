// Host-only administration of provider service accounts (spec/provider-service-accounts.md).
// Run inside the provider container: `bun src/cli/service-account.ts <command>`.
import { P256Keypair } from "@atproto/crypto";
import { loadConfig } from "../config.js";
import { ProviderDatabase } from "../db/database.js";
import { providerDiscoveryForOrigin } from "../discovery/delegation.js";
import { SafeHttpsTransport } from "../discovery/safe-fetch.js";
import { AddressVerifier } from "../discovery/verifier.js";
import { KeyEncryptor } from "../identity/key-encryption.js";
import { ProviderServiceAccounts } from "../onboarding/service-accounts.js";
import { createPlcDirectoryClient } from "../plc/client.js";
import { createHailDidResolver } from "../plc/public-resolver.js";

const usage = `Usage: bun src/cli/service-account.ts <command>
  recovery-key show             Print the provider recovery public key, if set
  recovery-key set <did:key>    Record an offline-generated provider recovery public key
  recovery-key generate         Generate the key, record its public half and print the private key ONCE
  create <name>                 Create (or resume creating) the service account <name>@<address domain>
  list                          List service accounts
  passkey-link admin            Print a single-use, ten-minute passkey enrollment link for admin@`;

const args = Bun.argv.slice(2), [command, argument, value] = args;
const shape = `${command} ${argument ?? ""}`.trim();
const valid = ["recovery-key show", "recovery-key generate", "list"].includes(shape) && args.length === (shape === "list" ? 1 : 2) ||
  shape === "recovery-key set" && args.length === 3 || ["create", "passkey-link"].includes(command ?? "") && args.length === 2;
if (!valid) { console.error(usage); process.exit(2); }

const config = loadConfig(), database = new ProviderDatabase(config.databaseUrl);
const plc = createPlcDirectoryClient(config.plcDirectoryUrl), resolver = createHailDidResolver(config, database.sql);
const transport = new SafeHttpsTransport();
const accounts = new ProviderServiceAccounts(database.sql, plc, resolver, new KeyEncryptor(config.keyEncryptionKey),
  config.plcDirectoryUrl, config.hailServiceBase,
  new AddressVerifier(plc, transport.fetch, transport.validateTarget, undefined, resolver, providerDiscoveryForOrigin(config.publicOrigin)),
  config.nativeAddressDomain, config.publicOrigin);
const print = (value: unknown) => console.info(JSON.stringify(value, null, 2));
try {
  await database.migrate();
  if (shape === "recovery-key show") print({ publicKey: await accounts.recoveryKey() });
  else if (shape === "recovery-key set") { await accounts.setRecoveryKey(value!); print({ publicKey: value }); }
  else if (shape === "recovery-key generate") {
    if (await accounts.recoveryKey()) throw new Error("A provider recovery key is already set");
    const pair = await P256Keypair.create({ exportable: true });
    await accounts.setRecoveryKey(pair.did());
    print({ type: "hail.provider-recovery-key", version: 1, publicKey: pair.did(),
      privateKeyHex: Buffer.from(await pair.export()).toString("hex"),
      warning: "Store this private key offline now. It is not saved on this server and cannot be shown again." });
  } else if (command === "list") print(await accounts.list());
  else if (command === "create") print(await accounts.create(argument!));
  else print(await accounts.passkeyLink(argument!));
} finally { await database.close(); }
