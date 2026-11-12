<script lang="ts">
  import type {Snippet} from 'svelte';
  import Icon from '$lib/Icon.svelte';
  let {view, locked=false, heading, floating=true, manual=true}: {
    view:{pending:boolean;busy:boolean;failure:string;apply:()=>void};
    locked?:boolean; heading?:Snippet; floating?:boolean;
    /** Show the always-present refresh button; the updates pill appears regardless. */
    manual?:boolean;
  }=$props();
  let showHint=$state(false);
  const available=$derived(view.pending || !!view.failure);
  const label=$derived(view.busy?'Refreshing messages':view.failure?'Retry refreshing messages':view.pending?'Updates available — refresh':'Refresh messages');
  $effect(()=>{
    if(!available || locked){showHint=false;return;}
    showHint=true;
    const timer=setTimeout(()=>{showHint=false;},4000);
    return ()=>clearTimeout(timer);
  });
</script>
{#if heading || manual}
<div class="refresh-heading" class:has-heading={!!heading} class:floating>
  {#if heading}<div class="heading-content">{@render heading()}</div>{/if}
  {#if manual}<button class="desktop-refresh hail-icon-button" disabled={view.busy||locked} onclick={()=>view.apply()} aria-label={label} title={label} aria-busy={view.busy}>
    <span class:spinning={view.busy}><Icon name="refresh" /></span>
  </button>{/if}
</div>
{/if}
<div class="refresh-status" class:floating aria-live="polite">
  {#if view.failure}<p role="status">{view.failure}</p>{/if}
  {#if available}<button class="updates-pill" disabled={view.busy||locked} onclick={()=>view.apply()} aria-label={label}><Icon name="refresh" size={16}/>{view.failure?'Retry refresh':'Updates available'}</button>{/if}
</div>
{#if floating && available && !locked}
  <div class="mobile-refresh-anchor">
    <span class="sr-only" role="status">{view.failure?"Mailbox refresh failed": "Mailbox updates available"}</span>
    {#if showHint}<span class="refresh-hint" aria-hidden="true">{view.failure?'Refresh failed — retry':'Updates available'}</span>{/if}
    <button class="mobile-refresh" disabled={view.busy} onclick={()=>view.apply()} aria-label={label} title={label} aria-busy={view.busy}>
      <span class="refresh-disc"><span class:spinning={view.busy}><Icon name="refresh" size={22}/></span></span>
    </button>
  </div>
{/if}
<style lang="postcss">
  @reference "../app.css";
  .refresh-heading { @apply flex items-start justify-end gap-[12px]; }
  .heading-content { @apply min-w-0 flex-1; }
  .refresh-heading:not(.has-heading) { @apply mb-[12px]; }
  .desktop-refresh { @apply text-muted; }
  .desktop-refresh > span, .refresh-disc > span { @apply flex; }
  .refresh-status:empty { @apply hidden; }
  .refresh-status { @apply flex flex-wrap items-center gap-[12px] mb-[16px]; }
  .refresh-status p { @apply m-0 text-[13px] text-muted; }
  .updates-pill { @apply inline-flex items-center justify-center gap-[6px] min-h-[36px] px-[12px] py-[6px] rounded-full [border:0] [background:var(--color-brand-soft)] text-brand-strong text-[13px] font-[600]; }
  .mobile-refresh-anchor { @apply hidden; }
  .spinning { animation:refresh-spin 1s linear infinite; }
  @keyframes refresh-spin { to {transform:rotate(360deg);} }
  @media(prefers-reduced-motion:reduce) { .spinning {animation:none;} }
  @media(max-width:900px) {
    .floating .desktop-refresh, .refresh-status.floating { @apply hidden; }
    .refresh-heading.floating:not(.has-heading) { @apply hidden; }
    .mobile-refresh-anchor {
      /* Midpoint between the centered primary action and the menu's center.
         44px target center shares the primary 56px button's 68px bottom offset. */
      @apply fixed z-[11] bottom-[calc(46px_+_env(safe-area-inset-bottom))] right-[calc(25%_-_1px)] w-[44px] h-[44px] block;
    }
    .mobile-refresh { @apply grid place-items-center w-[44px] h-[44px] p-0 rounded-full [border:0] [background:transparent]; }
    .refresh-disc { @apply grid place-items-center w-[40px] h-[40px] rounded-full [background:var(--color-brand)] text-on-brand [box-shadow:0_4px_16px_#0003]; }
    .mobile-refresh:hover .refresh-disc { @apply [background:var(--color-brand-strong)]; }
    .mobile-refresh:disabled { @apply opacity-[.65]; }
    .refresh-hint { @apply absolute left-[50%] [transform:translateX(-50%)] bottom-[54px] whitespace-nowrap pointer-events-none rounded-[10px] px-[12px] py-[8px] [background:var(--color-ink)] text-surface text-[12px] font-[600] [box-shadow:0_4px_16px_#0002]; }
    .refresh-hint::after { content:''; @apply absolute bottom-[-4px] left-[calc(50%_-_4px)] w-[8px] h-[8px] [background:var(--color-ink)] [transform:rotate(45deg)]; }
  }
  @media(max-width:540px) { .mobile-refresh-anchor { @apply right-[calc(25%_-_3px)]; } }
</style>
