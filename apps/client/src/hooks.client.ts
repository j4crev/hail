import {mailboxCounts} from '$lib/mailbox-counts.js';
import {mailboxCache} from '$lib/mailbox-cache.js';

export function init() {
  const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('hail-mailbox');
  channel?.addEventListener('message', event => {
    mailboxCache.clear(); mailboxCounts.set(null);
    if (event.data === 'logout') location.reload();
    else window.dispatchEvent(new Event('hail:mailbox-changed'));
  });
  const original = window.fetch.bind(window);
  window.fetch = async (input, options) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request?.url ?? String(input), location.href);
    const method = (options?.method ?? request?.method ?? 'GET').toUpperCase();
    const mutation = url.origin === location.origin && !['GET','HEAD','OPTIONS'].includes(method);
    if (mutation) {mailboxCache.beginMutation(); mailboxCounts.set(null);}
    try {
      const response = await original(input, options);
      if (response.status === 401 || response.status === 403) {mailboxCache.clear(); mailboxCounts.set(null);}
      return response;
    } finally {
      if (mutation) {
        mailboxCache.endMutation(); mailboxCounts.set(null);
        channel?.postMessage(url.pathname === '/auth/logout' ? 'logout' : 'changed');
        window.dispatchEvent(new Event('hail:mailbox-changed'));
      }
    }
  };
  // Native forms navigate away; enhanced forms use fetch above.
  window.addEventListener('pagehide', () => mailboxCache.clear());
  // A restored document contains old rendered account data even after cache eviction.
  window.addEventListener('pageshow', event => {if (event.persisted) location.reload();});
}
