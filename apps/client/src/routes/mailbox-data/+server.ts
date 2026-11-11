import {load as message} from '$lib/server/mailbox/message.js';
import {load as conversation} from '$lib/server/mailbox/conversation.js';
import {load as sentMessage} from '$lib/server/mailbox/sent-message.js';
import {load as sentSend} from '$lib/server/mailbox/sent-send.js';
import {canaryAccount} from '$lib/server/canary.js';
import {mailboxScope} from '$lib/server/mailbox-scope.js';
import {error, isRedirect, json} from '@sveltejs/kit';
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
  try {
    const data = await loader({...event, url, params});
    let counts = null;
    if ('account' in data) {
      try {const {client} = await canaryAccount(event.cookies,url); counts = await client.jmap('HailMailbox/view',{view:'unreadCounts'});} catch { /* Counts are optional presentation data. */ }
    }
    return json({data, counts, scope:mailboxScope(event.cookies)}, {headers:{'cache-control':'no-store'}});
  } catch (cause) {
    // Do not follow redirects as JSON, especially expired-session redirects.
    if (isRedirect(cause)) return json({redirect:cause.location,status:cause.status}, {headers:{'cache-control':'no-store'}});
    throw cause;
  }
};
