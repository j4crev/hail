import {mailboxScope as scope} from "$lib/server/mailbox-scope.js";
import {env} from "$env/dynamic/private";
import {brandingFromEnvironment} from "$lib/branding.js";
import {canaryAccount, isConfigured} from "$lib/server/canary.js";

export async function load({cookies, url, depends, untrack = <T>(fn:()=>T)=>fn()}) {
  depends("hail:mailbox");
  depends("hail:counts");
  let unreadCounts: {subscriptions: number; connections: number} | null = null;
  // Presentation only. Page loaders still validate the provider session.
  const hasAccountSession = isConfigured(cookies);
  let unseenConnections: number | null = null;
  let accountAvatar: {did: string; src: string} | null = null;
  const focused = untrack(() => (url.pathname === "/" && url.searchParams.has("next")) ||
    url.pathname.startsWith("/auth/") || url.pathname.startsWith("/signup"));
  if (hasAccountSession && !focused) {
    try {
      const {account, client} = await canaryAccount(cookies, url);
      accountAvatar = {did:account.did,src:`/api/v1/account/senders/${encodeURIComponent(account.did)}/avatar/image`};
      const counts = await client.request("/unread-counts");
      if (typeof counts.unseenConnections === "number" && Number.isSafeInteger(counts.unseenConnections) && counts.unseenConnections >= 0) unseenConnections = counts.unseenConnections;
      if (typeof counts.subscriptions === "number" && typeof counts.connections === "number" && Number.isSafeInteger(counts.subscriptions) && counts.subscriptions >= 0 && Number.isSafeInteger(counts.connections) && counts.connections >= 0) unreadCounts = {subscriptions:counts.subscriptions,connections:counts.connections};
    } catch {
      // Optional navigation data must not block navigation or sign-in.
    }
  }
  const mailboxScope = scope(cookies);
  return {mailboxScope,hasAccountSession, accountAvatar, unreadCounts, unseenConnections, branding: brandingFromEnvironment(env)};
}
