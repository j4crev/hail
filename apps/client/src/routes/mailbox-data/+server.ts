import {load as message} from '$lib/server/mailbox/message.js';
import {load as conversation} from '$lib/server/mailbox/conversation.js';
import {load as sentMessage} from '$lib/server/mailbox/sent-message.js';
import {load as sentSend} from '$lib/server/mailbox/sent-send.js';
import {canaryAccount} from '$lib/server/canary.js';
import {mailboxScope} from '$lib/server/mailbox-scope.js';
import {error, isRedirect, json} from '@sveltejs/kit';
import {providerBusy} from '$lib/server/provider-busy.js';
import {load as feed} from '$lib/server/mailbox/feed.js';
import {load as sent} from '$lib/server/mailbox/sent.js';
import {load as trash} from '$lib/server/mailbox/trash.js';
import {load as drafts} from '$lib/server/mailbox/drafts.js';

// GUI presentation data, not a provider or federation API. Each loader authenticates.
export const GET: import('./$types').RequestHandler = async event => {
  const path = event.url.searchParams.get('path') ?? '';
  const url = new URL(path, event.url.origin);
  const loaders = {'/':feed, '/sent':sent, '/trash':trash, '/drafts':drafts};
  if (!path.startsWith('/') || url.origin !== event.url.origin) error(400);
  const detail = url.pathname.match(/^\/(message|conversation)\/([^/]+)\/([^/]+)$/);
  const sentDetail = url.pathname.match(/^\/sent\/([^/]+)$/);
  const sendDetail = url.pathname.match(/^\/sent\/send\/([^/]+)\/([^/]+)$/);
  const params:Record<string,string> = detail ? {sender:decodeURIComponent(detail[2]),messageId:decodeURIComponent(detail[3])}
    : sendDetail ? {kind:decodeURIComponent(sendDetail[1]),messageId:decodeURIComponent(sendDetail[2])}
    : sentDetail ? {messageId:decodeURIComponent(sentDetail[1])} : {};
  const loader = Object.hasOwn(loaders,url.pathname) ? loaders[url.pathname as keyof typeof loaders]
    : detail ? detail[1] === 'message' ? message : conversation : sendDetail ? sentSend : sentDetail ? sentMessage : null;
  if (!loader) error(400);
  // Server-Timing (shown in the browser's network panel): where this request's
  // time goes. Durations only; no content or identifiers.
  const timing:string[] = [], started = performance.now();
  const mark = async <V>(name:string, work:Promise<V>) => {
    const start = performance.now();
    try {return await work;} finally {timing.push(`${name};dur=${(performance.now() - start).toFixed(1)}`);}
  };
  try {
    // Counts are optional presentation data: read them alongside the page's own
    // data rather than after it, and never let them fail the page.
    // Only pages that show account data (and so the sidebar) carry counts.
    const unread = loader === sentSend || loader === sentMessage ? null :
      canaryAccount(event.cookies,url).then(({client}) => client.jmap('HailMailbox/view',{view:'unreadCounts'})).catch(() => null);
    // The account read is shared with the loader (one per request).
    await mark('account', canaryAccount(event.cookies,url).catch(() => null));
    const data:Record<string, unknown> = await mark('load', loader({...event, url, params}) as Promise<Record<string, unknown>>);
    const counts = 'account' in data ? await mark('counts', Promise.resolve(unread)) : null;
    // Each provider round trip this request made, with the provider's own breakdown.
    const account = await canaryAccount(event.cookies,url).catch(() => null);
    account?.client.timings.forEach((trip, index) => {
      const desc = trip.path.replace(/[^A-Za-z0-9/._-]/g, '').slice(0, 64);
      timing.push(`p${index};desc="${desc}";dur=${trip.ms.toFixed(1)}`);
      for (const item of trip.server?.split(',') ?? []) {
        const [name, ...rest] = item.trim().split(';');
        if (name && /^[A-Za-z0-9_-]{1,16}$/.test(name)) timing.push([`p${index}.${name}`, ...rest].join(';'));
      }
    });
    const encodeStart = performance.now();
    const body = JSON.stringify({data, counts, scope:mailboxScope(event.cookies)});
    timing.push(`encode;dur=${(performance.now() - encodeStart).toFixed(1)}`, `total;dur=${(performance.now() - started).toFixed(1)}`);
    return new Response(body, {headers:{'content-type':'application/json','cache-control':'no-store','server-timing':timing.join(', ')}});
  } catch (cause) {
    // Do not follow redirects as JSON, especially expired-session redirects.
    if (isRedirect(cause)) return json({redirect:cause.location,status:cause.status}, {headers:{'cache-control':'no-store'}});
    // A busy or rate-limited provider is temporary: say when to retry instead of failing as a 500.
    const retryAfter = providerBusy(cause);
    if (retryAfter !== null) return json({message:'Your provider is busy. Please try again shortly.'}, {status:503, headers:{'cache-control':'no-store','retry-after':String(retryAfter)}});
    throw cause;
  }
};
