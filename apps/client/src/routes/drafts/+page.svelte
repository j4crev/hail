<script lang="ts">
  import {mailboxView} from "$lib/mailbox-view.svelte.js";
  import MailboxRefresh from "$lib/MailboxRefresh.svelte";
  import {page} from '$app/state';
  import DraftList from '$lib/DraftList.svelte';
  import MailboxEmptyState from '$lib/MailboxEmptyState.svelte';
  let {data:loaded}=$props();
  let draftSelection=$state(false);
  const mailbox = mailboxView(()=>loaded, ()=>page.url, ()=>draftSelection);
  let data=$derived(mailbox.data);
</script>
<svelte:head><title>Drafts · {page.data.branding?.name??'Hail'}</title></svelte:head>
<div class="min-w-0 pb-28 min-[901px]:pb-0">
  <MailboxRefresh view={mailbox} locked={draftSelection}>
    {#snippet heading()}<header class="page-heading"><h1 class="hail-title">Drafts</h1></header>{/snippet}
  </MailboxRefresh>
  <DraftList onselection={active=>draftSelection=active} drafts={data.drafts} address={data.account.address} trashEnabled={data.trashEnabled}/>
  {#if !data.drafts.length}<MailboxEmptyState icon="compose" title="No writer's block here."/>{/if}
  {#if data.paged||data.next}<nav class="mt-6 flex gap-3" aria-label="Draft pages">{#if data.paged}<a href="/drafts">Newest drafts</a>{/if}{#if data.next}<button disabled={mailbox.busy||mailbox.pending} onclick={()=>mailbox.older("after",data.next)}>{mailbox.batches >= 4 ? "Continue to older history" : "Load older"}</button>{/if}</nav>{/if}
</div>
