import {requireFreshPublicAuthority} from "../plc/authority.js";
import type {SQL} from "bun";
import {ed25519PublicKeyFromDidKey} from "../identity/did-key.js";
import {importEd25519PrivateKey} from "../identity/keys.js";
import type {KeyEncryptor} from "../identity/key-encryption.js";
import type {OnboardingRepository} from "../onboarding/repository.js";
import type {HailDidResolver} from "../plc/resolver.js";
import {parseRetrievalSignature, signRetrievalRequest} from "../http/retrieval-signature.js";

export class BodyRequestVerifier {
  constructor(private readonly sql: SQL, private readonly resolver: HailDidResolver, private readonly publicOrigin: string) {}

  async verify(request: Request, recipient: string, signal: AbortSignal): Promise<boolean> {
    // Pin the external origin; never trust forwarded/Host fields to supply it.
    const url = new URL(request.url);
    const target = `${this.publicOrigin}${url.pathname}${url.search}`;
    const proof = parseRetrievalSignature(request, recipient, target);
    if (!proof || signal.aborted) return false;
    const resolved = await (this.resolver.resolveForAuthentication?.(recipient) ?? this.resolver.resolve(recipient));
    if (resolved.did !== recipient || signal.aborted) return false;
    const key = await ed25519PublicKeyFromDidKey(resolved.messagingDidKey);
    if (!await crypto.subtle.verify('Ed25519', key, Uint8Array.from(proof.signature), Uint8Array.from(proof.bytes)) || signal.aborted) return false;
    await this.resolver.retainAuthenticatedResolution?.(resolved);
    await requireFreshPublicAuthority(this.sql,resolved.evidence,{did:recipient,role:'hail-messaging',key:resolved.messagingDidKey},new Date());
    if (signal.aborted) return false;
    // Provider-wide nonce scope, durable and atomic across workers/restarts. Do
    // not delete unexpired nonces on account transfer or messaging-key rotation.
    const accepted = await this.sql`INSERT INTO body_request_nonces(recipient_did,nonce,expires_at)
      SELECT ${recipient},${Buffer.from(proof.nonce,'base64url')},${proof.retainUntil}
      WHERE floor(extract(epoch FROM clock_timestamp()))<=${proof.retainUntil}
      ON CONFLICT(recipient_did,nonce) DO UPDATE SET expires_at=excluded.expires_at
        WHERE body_request_nonces.expires_at<floor(extract(epoch FROM clock_timestamp()))
      RETURNING recipient_did`;
    // Bounded cleanup; stale entries never permit an expired signature.
    await this.sql`DELETE FROM body_request_nonces WHERE ctid IN
      (SELECT ctid FROM body_request_nonces WHERE expires_at<floor(extract(epoch FROM clock_timestamp())) ORDER BY expires_at LIMIT 100)`;
    return accepted.length === 1 && !signal.aborted;
  }
}

export class BodyRequestSigner {
  constructor(private readonly sql: SQL, private readonly accounts: OnboardingRepository,
    private readonly encryptor: KeyEncryptor, private readonly resolver: HailDidResolver, private readonly serviceBase: string) {}

  sign = async (request: Request, recipient: string): Promise<Request> => {
    const account = (await this.sql<{id:string}[]>`SELECT id FROM provider_accounts WHERE did=${recipient}
      AND onboarding_state='active' AND activation_verification_mode='public' AND closed_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM provider_migration_fences f WHERE f.account_id=provider_accounts.id)`)[0];
    if (!account) throw new Error('Recipient is not active here');
    const key = await this.accounts.getKey(account.id,'hail-messaging');
    const resolved = await this.resolver.resolve(recipient);
    if (resolved.did !== recipient || key.algorithm !== 'ed25519' || key.publicKey !== resolved.messagingDidKey || resolved.serviceBase !== this.serviceBase)
      throw new Error('Current PLC does not authorize retrieval signing');
    await requireFreshPublicAuthority(this.sql,resolved.evidence,{did:recipient,role:'hail-messaging',key:key.publicKey,serviceBase:this.serviceBase},new Date());
    const secret = await this.encryptor.decrypt(account.id,key.role,key.algorithm,key.publicKey,key);
    try {return await signRetrievalRequest(request, recipient, await importEd25519PrivateKey(secret));}
    finally {secret.fill(0);}
  };
}
