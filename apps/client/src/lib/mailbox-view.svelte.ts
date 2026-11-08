import {onMount, untrack} from 'svelte';
import {goto} from '$app/navigation';
import {isRedirect} from '@sveltejs/kit';
import {mailboxCache, StaleMailboxRead} from './mailbox-cache.js';
import {readMailbox, mailboxKey} from './mailbox-load.js';
import {appendMailbox} from './mailbox-history.js';

export function mailboxView<T extends {mailboxKey?:string;mailboxCached?:boolean}>(source:()=>T, url:()=>URL, locked:()=>boolean = ()=>false, deferChanges = false) {
  let data = $state.raw<T>(untrack(source));
  let pending = $state.raw<T | null>(null);
  let busy = $state(false), failure = $state(''), batches = $state(0);
  let pendingGeneration = 0, historyGeneration = mailboxCache.generation, recentFingerprint = "";
  let mounted = false, lastCheck = 0, failures = 0, version = 0;
  $effect(() => {
    const next = source();
    untrack(() => {data = next; recentFingerprint = fingerprint(next); historyGeneration = mailboxCache.generation; pending = null; batches = 0; version++; lastCheck = next.mailboxCached ? 0 : Date.now(); if (mounted && next.mailboxCached) queueMicrotask(()=>void refresh(true));});
  });
  // Operation IDs are fresh form defaults, not mailbox changes.
  const fingerprint = (value:T) => JSON.stringify(value, (key,item)=>['newReplyId','newReplyUntil','newRevivalId','mailboxCached'].includes(key)?undefined:item);
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
      if (applyNow || fingerprint(result) !== recentFingerprint || generation !== historyGeneration) {
        if (!applyNow && (deferChanges || locked() || batches || location.searchParams.has('after') || location.searchParams.has('sentAfter') || location.searchParams.has('draftAfter') || window.scrollY > 100)) {pending = result; pendingGeneration = generation;}
        else {data = result; recentFingerprint = fingerprint(result); historyGeneration = generation; pending = null; batches = 0;}

      }
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
  function apply() {
    if (locked()) return;
    if (pending && pendingGeneration === mailboxCache.generation) {data = pending; recentFingerprint = fingerprint(pending); historyGeneration = pendingGeneration; pending = null; batches = 0; version++;}
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
  return {get data(){return data;},get pending(){return !!pending;},get busy(){return busy;},get failure(){return failure;},get batches(){return batches;},refresh,older,apply};
}
