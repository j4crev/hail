import {onMount, untrack} from 'svelte';
import {goto} from '$app/navigation';
import {isRedirect} from '@sveltejs/kit';
import {mailboxCache, StaleMailboxRead} from './mailbox-cache.js';
import {readMailbox, mailboxKey} from './mailbox-load.js';
import {appendMailbox} from './mailbox-history.js';

/**
 * Fields the root layout adds to every page's data (see routes/+layout.server.ts).
 * When only these change, the page's own content was not reloaded.
 */
const LAYOUT_DATA = new Set(['mailboxScope','hasAccountSession','accountAvatar','inboundEmail','unreadCounts','unseenConnections','branding']);

export function mailboxView<T extends {mailboxKey?:string;mailboxCached?:boolean}>(source:()=>T, url:()=>URL, locked:()=>boolean = ()=>false, deferChanges = false) {
  let data = $state.raw<T>(untrack(source));
  let pending = $state.raw<T | null>(null);
  let busy = $state(false), failure = $state(''), batches = $state(0);
  let pendingGeneration = 0, historyGeneration = mailboxCache.generation;
  // What is on screen, compared with each refresh to decide whether anything changed.
  let recent = untrack(source) as Record<string, unknown>;
  let mounted = false, lastCheck = 0, failures = 0, version = 0, previous = untrack(source) as Record<string, unknown>;
  $effect(() => {
    const next = source();
    untrack(() => {
      const before = previous; previous = next as Record<string, unknown>;
      const changedKeys = Object.keys(next).filter(key => (next as Record<string, unknown>)[key] !== before[key]);
      // A layout reload (counts every 30 seconds) must not replace refreshed page
      // content with the page's original copy; carry over only the layout fields.
      if (before !== next && changedKeys.every(key => LAYOUT_DATA.has(key))) {
        data = {...data, ...Object.fromEntries(changedKeys.map(key => [key, (next as Record<string, unknown>)[key]]))} as T;
        return;
      }
      data = next; recent = next as Record<string, unknown>; historyGeneration = mailboxCache.generation; pending = null; batches = 0; version++; lastCheck = next.mailboxCached ? 0 : Date.now(); if (mounted && next.mailboxCached) queueMicrotask(()=>void refresh(true));
    });
  });
  // Operation IDs are fresh form defaults, not mailbox changes.
  const fingerprint = (value:unknown) => JSON.stringify(value, (key,item)=>['newReplyId','newReplyUntil','mailboxCached'].includes(key)?undefined:item);
  // Page data also carries the layout's fields (counts, branding), which a refresh
  // never returns. Compare only the fields the refresh did return, or every check
  // would look like a change.
  const differs = (result:Record<string, unknown>) =>
    fingerprint(result) !== fingerprint(Object.fromEntries(Object.keys(result).map(key=>[key, recent[key]])));
  const scope = () => source().mailboxKey?.split(':')[0] ?? '';
  async function refresh(force = false, applyNow = false) {
    if (!mounted || busy || mailboxCache.mutations || document.visibilityState !== 'visible' || !scope()) return;
    if (!force && Date.now() - lastCheck < Math.min(300_000, 30_000 * 2 ** failures)) return;
    busy = true; lastCheck = Date.now();
    const generation = mailboxCache.generation, current = version;
    const location = new URL(url());
    try {
      const next = await mailboxCache.request(mailboxKey(scope(), location), () => readMailbox<T>(fetch, location, scope()));
      if (!mounted || current !== version || generation !== mailboxCache.generation) return;
      const result = {...next, mailboxKey:source().mailboxKey};
      // A cache generation changes on any mailbox change anywhere. Pages that defer
      // updates (an open message) offer one only when their own content changed.
      if (applyNow || differs(result) || (!deferChanges && generation !== historyGeneration)) {
        if (!applyNow && (deferChanges || locked() || batches || location.searchParams.has('after') || location.searchParams.has('sentAfter') || location.searchParams.has('draftAfter') || window.scrollY > 100)) {pending = result; pendingGeneration = generation;}
        else {data = result; recent = result; historyGeneration = generation; pending = null; batches = 0;}
      } else if (deferChanges) historyGeneration = generation;
      failure = ''; failures = 0;
    } catch (cause) {
      if (isRedirect(cause)) {await goto(cause.location, {invalidateAll:true}); return;}
      if (!(cause instanceof StaleMailboxRead)) {failure = 'Unable to refresh. Showing previously loaded messages.'; failures++;}
    } finally {busy = false;}
  }
  async function older(cursor:string, value:string | null | undefined) {
    if (!value || busy || locked() || pending) return;
    if (batches >= 4) {
      const destination = new URL(url()); destination.searchParams.set(cursor,value);
      await goto(destination); return;
    }
    busy = true;
    const generation = mailboxCache.generation, current = version;
    const destination = new URL(url()); destination.searchParams.set(cursor,value);
    try {
      const next = await mailboxCache.request(mailboxKey(scope(),destination), () => readMailbox<T>(fetch,destination,scope()));
      if (!mounted || current !== version || generation !== mailboxCache.generation) return;
      const combined = appendMailbox(data,next,cursor);
      if (JSON.stringify(combined).length * 2 > 8_000_000) {await goto(destination); return;}
      data = combined; batches++; failure = '';
    } catch (cause) {
      if (isRedirect(cause)) {await goto(cause.location,{invalidateAll:true}); return;}
      failure = 'Unable to load older messages. Please try again.';
    } finally {busy = false;}
  }
  /**
   * Records a change this page made itself, so it is not offered back as an
   * update. With display false only the comparison baseline changes, for pages
   * that already show the change in their own state.
   */
  function adopt(update:(value:T)=>T, display = true) {
    if (display) data = update(data);
    recent = update(recent as T) as Record<string, unknown>;
    if (pending) pending = update(pending);
    historyGeneration = mailboxCache.generation;
  }
  function apply() {
    if (locked()) return;
    if (pending && pendingGeneration === mailboxCache.generation) {data = pending; recent = pending as Record<string, unknown>; historyGeneration = pendingGeneration; pending = null; batches = 0; version++;}
    else {pending = null; void refresh(true,true);}
  }
  onMount(() => {
    mounted = true;
    const focus = () => {void refresh();};
    // Reader actions already update local state and explicitly invalidate counts.
    // Revalidate reader metadata on the next tick, preserving thread selection
    // and avoiding a second body download immediately after marking it read.
    const changed = () => {lastCheck = 0; if (!deferChanges) void refresh(true);};
    window.addEventListener('focus',focus);
    window.addEventListener('hail:mailbox-changed',changed);
    document.addEventListener('visibilitychange',focus);
    const interval = setInterval(focus, 30_000 + Math.random()*5000);
    if (source().mailboxCached) void refresh(true);
    return () => {mounted = false; version++; clearInterval(interval); window.removeEventListener('focus',focus); window.removeEventListener('hail:mailbox-changed',changed); document.removeEventListener('visibilitychange',focus);};
  });
  return {get data(){return data;},get pending(){return !!pending;},get busy(){return busy;},get failure(){return failure;},get batches(){return batches;},refresh,older,apply,adopt};
}
