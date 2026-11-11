import {randomBytes, randomUUID} from "node:crypto";
import type {SQL} from "bun";
import {tokenHash, type AccountApiScope, type AccountApiSession} from "./repository.js";
import {DEFAULT_SESSION_POLICY, type SessionPolicy} from "./session-policy.js";

/** Verified by trusted server code, never deserialized directly from a browser. */
export interface ProviderIdentity {
  issuer: string;
  tenant: string;
  subject: string;
  /** Non-secret reference into the provider's existing session store. */
  sessionId: string;
  authenticatedAt: Date;
  expiresAt: Date;
  active: boolean;
}

export interface ProviderAuthenticationIntegration {
  id: string;
  authorities: readonly {issuer: string; tenant: string}[];
  /** Validate an existing application's session. Do not accept raw identity claims. */
  login(proof: string): Promise<ProviderIdentity | null>;
  /** Revalidate session and organization access on EVERY authenticated request. */
  checkSession(sessionId: string): Promise<ProviderIdentity | null>;
}

// Credential delegation is deliberately excluded: otherwise an issued bearer
// could outlive organizational access. Owner actions retain their separate proof.
export const PROVIDER_LOGIN_SCOPES = ["account:read", "grants:read", "messages:read", "messages:write"] as const;
export class ProviderAuthenticationError extends Error {}
const validText = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 2048;

export class ProviderAuthentication {
  private readonly integrations = new Map<string, ProviderAuthenticationIntegration>();
  constructor(private readonly sql: SQL, integrations: readonly ProviderAuthenticationIntegration[],
    private readonly policy: Readonly<SessionPolicy> = DEFAULT_SESSION_POLICY) {
    if (!Number.isSafeInteger(policy.idleSeconds) || !Number.isSafeInteger(policy.absoluteSeconds) ||
      policy.idleSeconds < 1 || policy.absoluteSeconds < policy.idleSeconds || policy.absoluteSeconds > 31_536_000)
      throw new Error("Invalid provider session policy");
    for (const integration of integrations) {
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(integration.id) || this.integrations.has(integration.id) ||
        !integration.authorities.length || integration.authorities.some(a => !validText(a.issuer) || !validText(a.tenant)))
        throw new Error("Invalid provider authentication integration");
      // Snapshot trust policy: changes require an explicit new configuration.
      this.integrations.set(integration.id, {
        id: integration.id, authorities: integration.authorities.map(a => ({...a})),
        login: proof => integration.login(proof), checkSession: id => integration.checkSession(id),
      });
    }
  }

  private trusted(integration: ProviderAuthenticationIntegration, identity: ProviderIdentity | null): identity is ProviderIdentity {
    const now = Date.now();
    return !!identity && identity.active === true && validText(identity.subject) && validText(identity.sessionId) &&
      integration.authorities.some(a => a.issuer === identity.issuer && a.tenant === identity.tenant) &&
      identity.authenticatedAt instanceof Date && identity.expiresAt instanceof Date &&
      Number.isFinite(identity.authenticatedAt.getTime()) && Number.isFinite(identity.expiresAt.getTime()) &&
      identity.authenticatedAt.getTime() <= now && identity.expiresAt.getTime() > now &&
      identity.authenticatedAt.getTime() + this.policy.absoluteSeconds * 1000 > now;
  }

  /** Administrative provisioning only. No public route or email-based linking. */
  async bind(input: {integration: string; issuer: string; tenant: string; subject: string; accountId: string; scopes: readonly AccountApiScope[]}) {
    const integration = this.integrations.get(input.integration);
    if (!integration || !integration.authorities.some(a => a.issuer === input.issuer && a.tenant === input.tenant) ||
      !validText(input.subject) || !input.scopes.length || new Set(input.scopes).size !== input.scopes.length ||
      input.scopes.some(s => !(PROVIDER_LOGIN_SCOPES as readonly string[]).includes(s)))
      throw new ProviderAuthenticationError("Provider identity binding refused");
    const id = randomUUID();
    const rows = await this.sql`INSERT INTO account_provider_identities
      (id,integration,issuer,tenant,subject,account_id,serving_generation,scopes)
      SELECT ${id},${input.integration},${input.issuer},${input.tenant},${input.subject},a.id,g.generation,
        (${JSON.stringify(input.scopes)}::text)::jsonb
      FROM provider_accounts a JOIN account_serving_generations g ON g.account_id=a.id
      WHERE a.id=${input.accountId} AND a.closed_at IS NULL AND a.onboarding_state='active' AND a.did IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM provider_migration_fences f WHERE f.account_id=a.id)
      ON CONFLICT (integration,issuer,tenant,subject) DO NOTHING RETURNING id`;
    if (!rows.length) throw new ProviderAuthenticationError("Identity already bound or account unavailable");
    return id;
  }

  /** Call only after the host application has validated its login/CSRF flow. */
  async login(integrationId: string, proof: string) {
    const integration = this.integrations.get(integrationId);
    if (!integration || !validText(proof)) throw new ProviderAuthenticationError("Login refused");
    const identity = await integration.login(proof);
    if (!this.trusted(integration, identity)) throw new ProviderAuthenticationError("Login refused");
    const token = `hailps_${randomBytes(32).toString("base64url")}`, id = randomUUID();
    const expiresAt = new Date(Math.min(identity.expiresAt.getTime(), identity.authenticatedAt.getTime() + this.policy.absoluteSeconds * 1000));
    const rows = await this.sql`INSERT INTO account_provider_sessions
      (id,token_hash,identity_id,upstream_session,authenticated_at,expires_at)
      SELECT ${id},${tokenHash(token)},b.id,${identity.sessionId},${identity.authenticatedAt},${expiresAt}
      FROM account_provider_identities b JOIN provider_accounts a ON a.id=b.account_id
        JOIN account_serving_generations g ON g.account_id=a.id AND g.generation=b.serving_generation
      WHERE b.integration=${integrationId} AND b.issuer=${identity.issuer} AND b.tenant=${identity.tenant}
        AND b.subject=${identity.subject} AND b.disabled_at IS NULL AND a.closed_at IS NULL
        AND a.onboarding_state='active' AND a.did IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM provider_migration_fences f WHERE f.account_id=a.id)
      RETURNING id`;
    if (!rows.length) throw new ProviderAuthenticationError("Login refused");
    return {token, sessionId: id, expiresAt};
  }

  async authenticate(token: string,touch=true): Promise<AccountApiSession | null> {
    return this.lookupSession(token,touch);
  }
  async authenticateReference(id:string):Promise<AccountApiSession|null>{return this.lookupSession(undefined,false,id);}
  private async lookupSession(token:string|undefined,touch:boolean,id?:string):Promise<AccountApiSession|null>{
    if (!id&&!/^hailps_[A-Za-z0-9_-]{43}$/.test(token??"")) return null;
    const row = (await this.sql<{
      id: string; integration: string; issuer: string; tenant: string; subject: string;
      upstream_session: string; authenticated_at: Date;
    }[]>`SELECT s.id,b.integration,b.issuer,b.tenant,b.subject,s.upstream_session,s.authenticated_at
      FROM account_provider_sessions s JOIN account_provider_identities b ON b.id=s.identity_id
      WHERE (s.token_hash=${tokenHash(token??"")} OR s.id=${id??null}::uuid) AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
        AND b.disabled_at IS NULL
        AND s.last_seen_at>clock_timestamp()-(${this.policy.idleSeconds}::double precision * interval '1 second')`)[0];
    if (!row) return null;
    const integration = this.integrations.get(row.integration);
    if (!integration) return null;
    // Exceptions propagate: an unavailable identity backend must never grant access.
    const identity = await integration.checkSession(row.upstream_session);
    if (!this.trusted(integration, identity) || identity.issuer !== row.issuer || identity.tenant !== row.tenant ||
      identity.subject !== row.subject || identity.sessionId !== row.upstream_session ||
      identity.authenticatedAt.getTime() !== row.authenticated_at.getTime()) return null;
    const sessions = await this.sql<(AccountApiSession & {scopes: AccountApiScope[]})[]>`
      UPDATE account_provider_sessions s SET last_seen_at=CASE WHEN ${touch} THEN clock_timestamp() ELSE s.last_seen_at END,expires_at=LEAST(s.expires_at,${identity.expiresAt})
      FROM account_provider_identities b,provider_accounts a,account_serving_generations g
      WHERE s.id=${row.id} AND b.id=s.identity_id AND b.disabled_at IS NULL
        AND a.id=b.account_id AND a.closed_at IS NULL AND a.onboarding_state='active' AND a.did IS NOT NULL
        AND g.account_id=a.id AND g.generation=b.serving_generation
        AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
        AND ${identity.expiresAt}::timestamptz>clock_timestamp()
        AND s.last_seen_at>clock_timestamp()-(${this.policy.idleSeconds}::double precision * interval '1 second')
        AND NOT EXISTS (SELECT 1 FROM provider_migration_fences f WHERE f.account_id=a.id)
      RETURNING a.id AS account_id,s.id AS credential_id,s.expires_at AS credential_expires_at,
        a.did,a.canonical_address,a.address_released_at,b.scopes,NULL::text AS migration_state,
        g.generation::integer AS serving_generation`;
    const session = sessions[0];
    if (!session) return null;
    // Also constrain DB policy at use time; adding delegation needs lifecycle design.
    if (!Array.isArray(session.scopes) || session.scopes.some(s => !(PROVIDER_LOGIN_SCOPES as readonly string[]).includes(s))) return null;
    return {...session, authentication: {method: "provider", authenticatedAt: row.authenticated_at}};
  }

  async revoke(token: string) {
    await this.sql`UPDATE account_provider_sessions SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE token_hash=${tokenHash(token)}`;
  }

  /** Permanent offboarding; explicit new provisioning is needed for future access. */
  async disable(identityId: string) {
    await this.sql`UPDATE account_provider_identities SET disabled_at=COALESCE(disabled_at,clock_timestamp()) WHERE id=${identityId}`;
  }
}
