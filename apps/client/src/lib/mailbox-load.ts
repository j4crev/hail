import {mailboxCounts} from './mailbox-counts.js';
import {browser} from '$app/environment';
import {error, redirect, type Load} from '@sveltejs/kit';
import {mailboxCache, StaleMailboxRead} from './mailbox-cache.js';

export function mailboxKey(scope:string, url:URL) {return scope + ':' + url.pathname + url.search;}
export async function readMailbox<T>(fetcher:typeof fetch, url:URL, scope?:string):Promise<T> {
  const generation = mailboxCache.generation;
  const response = await fetcher('/mailbox-data?path=' + encodeURIComponent(url.pathname + url.search), {cache:'no-store',signal:AbortSignal.timeout(30_000)});
  if (!response.ok) {
    if (browser && (response.status === 401 || response.status === 403)) mailboxCache.clear();
    error(response.status, 'Unable to refresh your mailbox. Please try again.');
  }
  const result = await response.json();
  if (result.redirect) {
    if (browser) mailboxCache.clear();
    redirect(result.status, result.redirect);
  }
  if (browser && scope && result.scope !== scope) {
    mailboxCache.clear();
    location.reload();
    throw new Error('Your account session changed. Reloading.');
  }
  if (browser && generation === mailboxCache.generation && !mailboxCache.mutations && result.scope && result.counts && ['subscriptions','connections'].every(key=>Number.isSafeInteger(result.counts[key]) && result.counts[key]>=0)) {
    mailboxCounts.set({scope:result.scope,counts:result.counts});
  }
  return result.data;
}
export function mailboxLoad<T>(followMailboxInvalidation = true) {
  return (async ({url, fetch, parent, depends, untrack}) => {
    if (followMailboxInvalidation) depends('hail:mailbox');
    const {mailboxScope} = await (followMailboxInvalidation ? parent() : untrack(parent));
    const key = mailboxKey(mailboxScope ?? '', url);
    const read = () => readMailbox<T>(fetch, url, mailboxScope);
    if (!browser || !mailboxScope) return {...await read(), mailboxKey:key, mailboxCached:false};
    // Navigation may race a read/Trash action. Wait for that action and retry
    // discarded reads, rather than turning a correctly rejected stale response
    // into a route error. Network/authentication failures still propagate.
    for (;;) {
      await mailboxCache.idle();
      try {
        const cached = mailboxCache.get<T>(key);
        return {...(cached ?? await mailboxCache.request(key,read)), mailboxKey:key, mailboxCached:cached !== undefined};
      }
      catch (cause) {if (!(cause instanceof StaleMailboxRead)) throw cause;}
    }
  }) satisfies Load;
}
