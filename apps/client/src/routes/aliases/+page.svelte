<script lang="ts">
  import Toast from "$lib/Toast.svelte";
  import MobileSheet from "$lib/MobileSheet.svelte";
  import Icon from "$lib/Icon.svelte";
  import CopyButton from "$lib/CopyButton.svelte";
  import MailboxEmptyState from "$lib/MailboxEmptyState.svelte";
  import SelectionAvatar from "$lib/SelectionAvatar.svelte";
  import SelectionActions from "$lib/SelectionActions.svelte";
  import {page} from "$app/state";
  import {afterNavigate,invalidateAll} from "$app/navigation";
  import {accountOperation} from "$lib/jmap.js";
  import {parseAliases,type EmailAlias} from "$lib/inbound-email.js";
  let {data}=$props();
  let addOpen=$state(false),label=$state(""),created=$state<EmailAlias|null>(null);
  let selected=$state<string[]>([]),confirming=$state(false),busy=$state(false),message=$state(""),failed=$state(false);
  let chosen=$derived(data.aliases.filter(alias=>selected.includes(alias.id)));
  afterNavigate(({from,to})=>{if(from?.url.pathname!==to?.url.pathname){selected=[];confirming=false;}});
  $effect(()=>{if(!addOpen){created=null;label="";}});
  function toggle(id:string){selected=selected.includes(id)?selected.filter(value=>value!==id):[...selected,id];confirming=false;}
  async function run(action:()=>Promise<void>){
    if(busy)return;busy=true;message="";failed=false;
    try{await action();}catch(error){failed=true;message=error instanceof Error?error.message:"Unable to update your aliases. Try again.";}
    finally{busy=false;}
  }
  async function create(){
    const result=await accountOperation("HailEmailAlias/create",{label:label.trim()});
    created=parseAliases([result.alias])[0]!;label="";
    await invalidateAll();
  }
  async function remove(){
    const ids=chosen.map(alias=>alias.id),result=await accountOperation("HailEmailAlias/destroy",{ids});
    const destroyed=Array.isArray(result.destroyed)?result.destroyed.length:0;
    selected=[];confirming=false;
    message=`Deleted ${destroyed} ${destroyed===1?"alias":"aliases"}.`;
    await invalidateAll();
  }
</script>

<svelte:head><title>Aliases · {page.data.branding?.name ?? "Hail"}</title><meta name="robots" content="noindex, nofollow" /></svelte:head>
<div class:has-selection={chosen.length>0} class="pb-28 min-[901px]:pb-0">
  <header class="mb-8"><h1 class="hail-title">Aliases</h1></header>
  {#if message}<Toast {message} error={failed} />{/if}
  {#if !data.inboundEmail.enabled}
    <section class="grid gap-3" aria-label="Inbound email is off">
      <MailboxEmptyState icon="at" title="Inbound email is off." />
      <p class="m-0 text-center text-sm text-muted">Turn on <a href="/settings">Inbound email</a> in Settings to create aliases.</p>
    </section>
  {:else}
    <MobileSheet bind:open={addOpen} title={created?"Alias created":"New alias"} disabled={busy}>
      {#if created}
        <section class="grid min-w-0 gap-4" aria-label="New alias">
          <p class="m-0 text-sm">Use this address when you subscribe to <strong>{created.label}</strong>. Its mail arrives in your Feed.</p>
          <div class="flex items-center gap-2">
            <!-- Break after the @ before splitting either part. -->
            <code class="alias-address min-w-0 flex-1">{created.address.split("@")[0]}@<wbr />{created.address.split("@")[1]}</code>
            <CopyButton value={created.address} label="Copy address" />
          </div>
          <button class="hail-button-secondary justify-self-start" onclick={()=>addOpen=false}>Done</button>
        </section>
      {:else}
        <form class="grid min-w-0 gap-4" aria-label="New alias" onsubmit={event=>{event.preventDefault();if(label.trim())void run(create);}}>
          <label class="hail-field">Name<input bind:value={label} maxlength="160" autocomplete="off" placeholder="The newsletter this is for" disabled={busy} /></label>
          <button class="hail-button justify-self-start" type="submit" disabled={busy||!label.trim()}>Create alias</button>
        </form>
      {/if}
    </MobileSheet>
    {#if !chosen.length&&!addOpen}<button class="mobile-floating-action" type="button" aria-label="New alias" onclick={()=>addOpen=true}><Icon name="plus" size={24}/></button>{/if}
  {/if}
  {#if data.aliases.length}
    <section class="grid min-w-0 gap-4" aria-label="Aliases">
      {#if chosen.length}
        <SelectionActions label="Alias actions" count={chosen.length} locked={busy} {busy} onclear={()=>{selected=[];confirming=false;}}
          onselectall={chosen.length<data.aliases.length?()=>selected=data.aliases.map(alias=>alias.id):undefined}>
          {#snippet actions()}<button class="hail-button-secondary" disabled={busy||confirming} onclick={()=>confirming=true}>Delete</button>{/snippet}
          {#if confirming}
            <div class="grid gap-3" role="group" aria-label="Confirm deletion">
              <p class="m-0 text-sm">Delete {chosen.length===1?"this alias":`${chosen.length} aliases`}? Mail sent to {chosen.length===1?"it":"them"} will be refused, and the {chosen.length===1?"address":"addresses"} can’t be used again. Messages you already received are kept.</p>
              <div class="flex flex-wrap gap-2">
                <button class="hail-button-secondary" disabled={busy} onclick={()=>confirming=false}>Cancel</button>
                <button class="hail-button-secondary text-danger [border-color:var(--color-danger)]" disabled={busy} onclick={()=>run(remove)}>Delete</button>
              </div>
            </div>
          {/if}
        </SelectionActions>
      {/if}
      <div class="compact-list">
        {#each data.aliases as alias (alias.id)}
          <article class="list-row contact-row" class:is-selected={selected.includes(alias.id)}>
            <SelectionAvatar name="@" icon="at" selected={selected.includes(alias.id)} disabled={busy} label={`Select alias ${alias.label}`} ontoggle={()=>toggle(alias.id)} />
            <div class="contact-copy">
              <h3>{alias.label}</h3>
              <code class="contact-identity" title={alias.address}>{alias.address}</code>
            </div>
          </article>
        {/each}
      </div>
    </section>
  {:else if data.inboundEmail.enabled}
    <MailboxEmptyState icon="at" title="No aliases yet." />
  {/if}
  {#if busy}<p class="mt-5! text-sm text-muted" role="status">Updating your aliases…</p>{/if}
</div>

<style lang="postcss">
  @reference "../../app.css";

  .alias-address { @apply block [overflow-wrap:anywhere] rounded-[8px] [padding:10px_12px] [background:var(--color-brand-soft)] text-[14px]; }
  @media (max-width:900px) {
    .has-selection { @apply pb-[180px]; }
  }
</style>
