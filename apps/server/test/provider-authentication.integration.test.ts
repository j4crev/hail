import {randomBytes, randomUUID} from "node:crypto";
import {SQL} from "bun";
import {Hono} from "hono";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {ProviderDatabase} from "../src/db/database.js";
import {AccountApiRepository} from "../src/accounts/repository.js";
import {ProviderAuthentication, type ProviderIdentity, type ProviderAuthenticationIntegration} from "../src/accounts/provider-authentication.js";
import {registerAccountApiRoutes} from "../src/accounts/routes.js";
import {registerPasskeyRoutes} from "../src/accounts/passkey-routes.js";
import {PasskeyAuth} from "../src/accounts/passkeys.js";
import type {GrantRepository} from "../src/grants/repository.js";
import type {GrantService} from "../src/grants/service.js";

const integration = process.env.DATABASE_URL ? describe : describe.skip;
integration("provider authentication boundary", () => {
  let db: ProviderDatabase, admin: SQL;
  const schema = `auth_${randomUUID().replaceAll("-", "")}`;
  beforeAll(async () => {
    admin = new SQL(process.env.DATABASE_URL!);
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);
    const url = new URL(process.env.DATABASE_URL!); url.searchParams.set("options", `-csearch_path=${schema}`);
    db = new ProviderDatabase(url.toString()); await db.migrate();
  });
  afterAll(async () => {await db?.close(); await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`); await admin.close();});

  async function fixture() {
    const accountId = randomUUID(), did = `did:plc:${randomBytes(24).toString("hex").slice(0,24).replace(/[0189]/g,"a")}`;
    await db.sql`INSERT INTO provider_accounts(id,tenant_id,canonical_address,did,onboarding_state,activated_at,activation_binding_digest,activation_verification_mode)
      VALUES(${accountId},${randomUUID()},${`${accountId}@example.com`},${did},'active',now(),${randomBytes(32)},'public')`;
    // Test host application: its existing session was established by its SSO
    // backend. Hail receives only a verified session, never an ID token or claims
    // posted by a browser. A production OIDC/SAML verifier is outside this fixture.
    let current: ProviderIdentity | null = {
      issuer: "https://id.example.com", tenant: "company-a", subject: randomUUID(),
      sessionId: randomUUID(), authenticatedAt: new Date(Date.now()-1000), expiresAt: new Date(Date.now()+3600_000), active: true,
    };
    const proof = randomBytes(32).toString("base64url");
    let unavailable = false;
    const adapter: ProviderAuthenticationIntegration = {
      id: "existing-mail", authorities: [{issuer: current.issuer, tenant: current.tenant}],
      async login(value) {return value === proof ? current : null;},
      async checkSession(id) {if (unavailable) throw new Error("SSO unavailable"); return current?.sessionId === id ? current : null;},
    };
    const auth = new ProviderAuthentication(db.sql, [adapter]);
    const binding = {integration: adapter.id, issuer: current.issuer, tenant: current.tenant, subject: current.subject,
      accountId, scopes: ["account:read", "messages:read"] as const};
    const bindingId = await auth.bind(binding);
    const accounts = new AccountApiRepository(db.sql, undefined, auth);
    const app = new Hono();
    registerAccountApiRoutes(app, accounts, {} as GrantRepository, {} as GrantService, "https://mail.example.com");
    registerPasskeyRoutes(app, new PasskeyAuth(db.sql,"mail.example.com","https://mail.example.com"), accounts, () => {});
    return {auth, accounts, app, adapter, proof, binding, bindingId, accountId, did,
      change(value: Partial<ProviderIdentity>) {current = {...current!, ...value};},
      offboard() {current = null;}, fail() {unavailable = true;},
      login: () => auth.login(adapter.id,proof)};
  }

  it("reuses an existing SSO application session through the real account API without a passkey", async () => {
    const f = await fixture(), session = await f.login();
    const result = await f.app.request("https://mail.example.com/api/v1/account", {headers: {Cookie: `hail_session=${session.token}`}});
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({did: f.did, scopes: ["account:read","messages:read"]});
    expect(await db.sql`SELECT * FROM account_passkeys WHERE account_id=${f.accountId}`).toHaveLength(0);
    await db.sql`UPDATE account_provider_sessions SET last_seen_at=now()-interval '2 minutes' WHERE id=${session.sessionId}`;
    const idleBefore=(await db.sql`SELECT last_seen_at FROM account_provider_sessions WHERE id=${session.sessionId}`)[0]!.last_seen_at;
    expect(await f.accounts.authenticate(undefined,session.token,false)).not.toBeNull();
    expect((await f.accounts.authenticateReference("provider",session.sessionId))?.credential_id).toBe(session.sessionId);
    expect((await db.sql`SELECT last_seen_at FROM account_provider_sessions WHERE id=${session.sessionId}`)[0]!.last_seen_at).toEqual(idleBefore);
    const identity = await f.accounts.authenticate(undefined,session.token);
    expect(identity?.authentication?.method).toBe("provider");
    expect(identity?.passkey_credential_id).toBeUndefined();
    await db.sql`UPDATE provider_accounts SET canonical_address=${`renamed-${f.accountId}@example.com`} WHERE id=${f.accountId}`;
    expect((await f.accounts.authenticate(undefined,session.token))?.canonical_address).toMatch(/^renamed-/);
    expect(await new AccountApiRepository(db.sql).authenticate(undefined,session.token)).toBeNull();
  });

  it.each([{issuer:"https://evil.example.com"},{tenant:"company-b"},{subject:"another-user"},{active:false},
    {authenticatedAt:new Date(Date.now()+3600_000)},{expiresAt:new Date(0)}])("refuses untrusted, wrong-tenant or inactive identities: %j", async change => {
    const f = await fixture(), session = await f.login(); f.change(change);
    await expect(f.login()).rejects.toThrow("Login refused");
    expect(await f.accounts.authenticate(undefined,session.token)).toBeNull();
    expect(await f.accounts.authenticateReference("provider",session.sessionId)).toBeNull();
  });

  it("rejects forged application proofs, raw claims and unknown integrations", async () => {
    const f = await fixture();
    await expect(f.auth.login(f.adapter.id, JSON.stringify(f.binding))).rejects.toThrow();
    await expect(f.auth.login("unknown", f.proof)).rejects.toThrow();
  });

  it("cannot link an identity to another account, even after disabling it", async () => {
    const f = await fixture(), other = await fixture();
    await expect(f.auth.bind({...f.binding, accountId:other.accountId})).rejects.toThrow();
    await f.auth.disable(f.bindingId);
    await expect(f.auth.bind({...f.binding, accountId:other.accountId})).rejects.toThrow();
    await expect(f.login()).rejects.toThrow();
  });

  it("rejects scope escalation, credential delegation and owner actions", async () => {
    const f = await fixture();
    await expect(f.auth.bind({...f.binding, subject:randomUUID(), scopes:["credentials:write"]})).rejects.toThrow();
    await expect(f.auth.bind({...f.binding, subject:randomUUID(), scopes:["account:write"]})).rejects.toThrow();
    const session = await f.login();
    for (const path of ["credentials","custody/managed","custody/owner-controlled"]) {
      const response = await f.app.request(`https://mail.example.com/api/v1/account/${path}`, {
        method:"POST", headers:{Cookie:`hail_session=${session.token}`,Origin:"https://mail.example.com","Content-Type":"application/json"},body:"{}",
      });
      expect(response.status).toBe(403);
    }
    await db.sql`UPDATE account_provider_identities SET scopes='["account:write"]' WHERE id=${f.bindingId}`;
    expect(await f.accounts.authenticate(undefined,session.token)).toBeNull();
    expect(await f.accounts.authenticateReference("provider",session.sessionId)).toBeNull();
  });

  it("enforces CSRF and refuses invalid Authorization rather than falling back to a cookie", async () => {
    const f = await fixture(), session = await f.login();
    expect((await f.app.request("https://mail.example.com/api/v1/account/credentials", {
      method:"POST",headers:{Cookie:`hail_session=${session.token}`,Origin:"https://evil.example.com"},
    })).status).toBe(403);
    expect(await f.accounts.authenticate("Basic invalid",session.token)).toBeNull();
    expect(await f.accounts.authenticate(`Bearer racr_${randomBytes(32).toString("base64url")}`,session.token)).toBeNull();
  });

  it("revokes sessions on local logout, organizational disable and upstream logout", async () => {
    const f = await fixture(), first = await f.login();
    const response = await f.app.request("https://mail.example.com/api/v1/auth/logout", {
      method:"POST",headers:{Cookie:`hail_session=${first.token}`,Origin:"https://mail.example.com"},
    });
    expect(response.status).toBe(200);
    expect(await f.accounts.authenticate(undefined,first.token)).toBeNull();
    const second = await f.login(); await f.auth.disable(f.bindingId);
    expect(await f.accounts.authenticate(undefined,second.token)).toBeNull();
    const other = await fixture(), third = await other.login(); other.offboard();
    expect(await other.accounts.authenticate(undefined,third.token)).toBeNull();
  });

  it("fails closed when the upstream session service is unavailable", async () => {
    const f = await fixture(), session = await f.login(); f.fail();
    expect((await f.app.request("https://mail.example.com/api/v1/account", {headers:{Cookie:`hail_session=${session.token}`}})).status).toBe(503);
  });

  it("rechecks disablement after an upstream call in flight", async () => {
    const f = await fixture(), session = await f.login(), check = f.adapter.checkSession;
    f.adapter.checkSession = async id => {const result = await check(id); await f.auth.disable(f.bindingId); return result;};
    expect(await f.accounts.authenticate(undefined,session.token)).toBeNull();
    expect(await f.accounts.authenticateReference("provider",session.sessionId)).toBeNull();
  });

  it("enforces idle and absolute expiry, account closure and serving generation", async () => {
    const f = await fixture(), session = await f.login();
    await db.sql`UPDATE account_provider_sessions SET last_seen_at=now()-interval '31 minutes' WHERE id=${session.sessionId}`;
    expect(await f.accounts.authenticate(undefined,session.token)).toBeNull();
    expect(await f.accounts.authenticateReference("provider",session.sessionId)).toBeNull();
    await db.sql`UPDATE account_provider_sessions SET last_seen_at=now(),expires_at=now()-interval '1 millisecond' WHERE id=${session.sessionId}`;
    expect(await f.accounts.authenticate(undefined,session.token)).toBeNull();
    expect(await f.accounts.authenticateReference("provider",session.sessionId)).toBeNull();
    const next = await f.login();
    await db.sql.begin(async tx => {await tx`SELECT set_config('hail.returning_account',${f.accountId},true)`;
      await tx`UPDATE account_serving_generations SET generation=2 WHERE account_id=${f.accountId}`;});
    expect(await f.accounts.authenticate(undefined,next.token)).toBeNull();
    await expect(f.login()).rejects.toThrow();
    const other = await fixture(), closed = await other.login();
    await db.sql`UPDATE provider_accounts SET address_released_at=now(),closed_at=now() WHERE id=${other.accountId}`;
    expect(await other.accounts.authenticate(undefined,closed.token)).toBeNull();
  });

  it("does not extend an existing session after reauthentication or silently change its identity", async () => {
    const f = await fixture(), session = await f.login();
    f.change({authenticatedAt:new Date()});
    expect(await f.accounts.authenticate(undefined,session.token)).toBeNull();
    expect(await f.accounts.authenticateReference("provider",session.sessionId)).toBeNull();
    const fresh = await f.login();
    expect(await f.accounts.authenticate(undefined,fresh.token)).not.toBeNull();
  });

  it("persists session revocation across service restart and rejects removed trust", async () => {
    const f = await fixture(), session = await f.login();
    const restarted = new ProviderAuthentication(db.sql, [f.adapter]);
    expect(await restarted.authenticate(session.token)).not.toBeNull();
    await f.auth.revoke(session.token);
    expect(await restarted.authenticate(session.token)).toBeNull();
    const next = await f.login();
    expect(await new ProviderAuthentication(db.sql, []).authenticate(next.token)).toBeNull();
    expect(await new ProviderAuthentication(db.sql, [{...f.adapter,
      authorities:[{issuer:f.binding.issuer,tenant:"different-organization"}]}]).authenticate(next.token)).toBeNull();
  });

  it("shortens upstream expiry without extending the local absolute deadline", async () => {
    const f = await fixture(), session = await f.login();
    f.change({expiresAt:new Date(Date.now()+7200_000)});
    expect((await f.accounts.authenticate(undefined,session.token))?.credential_expires_at).toEqual(session.expiresAt);
    const shorter = new Date(Date.now()+60_000); f.change({expiresAt:shorter});
    expect((await f.accounts.authenticate(undefined,session.token))?.credential_expires_at).toEqual(shorter);
    f.change({expiresAt:new Date(Date.now()+7200_000)});
    expect((await f.accounts.authenticate(undefined,session.token))?.credential_expires_at).toEqual(shorter);
    f.change({authenticatedAt:new Date(Date.now()-13*3600_000)});
    await expect(f.login()).rejects.toThrow();
  });

  it("preserves bindings and revocation records against destructive rollback", async () => {
    await fixture();
    const connection = await db.sql.reserve();
    try {
      await expect(connection.unsafe(await Bun.file(new URL("../migrations/rollback/0110_provider_authentication.sql",import.meta.url)).text())).rejects.toThrow("bindings prevent rollback");
      await connection.unsafe("ROLLBACK");
    } finally {connection.release();}
  });
});
