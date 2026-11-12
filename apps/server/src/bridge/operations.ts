import type { SQL } from "bun";
import { encodeBase64Url } from "@racrproto/codec";
import type { GrantRepository } from "../grants/repository.js";
import { EmailAliases, EmailBridgeError, type EmailAlias } from "./aliases.js";
import { bridgeAccount, bridgeGrant, type BridgeSender } from "./consent.js";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

export interface InboundEmailState {
  available: true;
  domain: string;
  sender: BridgeSender;
  /** Whether the account has granted the bridge: inbound email is on. */
  enabled: boolean;
  /** The Grant that turned it on, so the client can revoke it to turn it off. */
  grant: { grantId: string; revision: number; digest: string } | null;
}

const view = (alias: EmailAlias) => ({
  id: alias.id, address: alias.address, label: alias.label, createdAt: alias.createdAt.toISOString(),
  lastReceivedAt: alias.lastReceivedAt?.toISOString() ?? null, messageCount: alias.messageCount,
});

/** Account API for inbound email: its on/off state and the account's aliases. */
export class EmailAliasOperations {
  readonly aliases: EmailAliases;
  constructor(private readonly sql: SQL, private readonly grants: GrantRepository, readonly domain: string, readonly sender: BridgeSender) {
    this.aliases = new EmailAliases(sql, domain);
  }

  async state(account: { account_id: string; did: string }): Promise<InboundEmailState> {
    const bridge = await bridgeAccount(this.sql, this.sender);
    const granted = bridge ? await bridgeGrant(this.sql, account.did, bridge, this.sender.category) : null;
    const current = granted ? await this.grants.findCurrentByGrantId(granted.grantId) : null;
    const grant = current && current.localAccountId === account.account_id && current.localRole === "grantor"
      ? { grantId: current.payload.grant_id, revision: current.payload.revision, digest: encodeBase64Url(current.digest) } : null;
    return { available: true, domain: this.domain, sender: this.sender, enabled: grant !== null, grant };
  }

  async get(account: { account_id: string; did: string }, summary: boolean) {
    const state = await this.state(account);
    return summary ? state : { ...state, aliases: (await this.aliases.list(account.account_id)).map(view) };
  }

  /** Creating an alias whose mail would be refused helps nobody, so inbound email must be on. */
  async create(account: { account_id: string; did: string }, label: unknown) {
    if (!(await this.state(account)).enabled) throw new EmailBridgeError(409, "Turn on inbound email before creating an alias");
    return { alias: view(await this.aliases.create(account.account_id, { label })) };
  }

  async destroy(accountId: string, ids: unknown) {
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 50 || ids.some(id => typeof id !== "string" || !UUID.test(id)) ||
      new Set(ids).size !== ids.length) throw new EmailBridgeError(400, "Choose 1 to 50 aliases");
    const destroyed: string[] = [], notFound: string[] = [];
    for (const id of ids as string[]) {
      try { await this.aliases.remove(accountId, id); destroyed.push(id); }
      catch (error) { if (error instanceof EmailBridgeError && error.status === 404) notFound.push(id); else throw error; }
    }
    return { destroyed, notFound };
  }
}
