<script lang="ts">
  import MessageSender from "$lib/MessageSender.svelte";
  import {restoreReceivedMessage} from "$lib/jmap.js";
  import {mailboxView} from "$lib/mailbox-view.svelte.js";
  import MailboxRefresh from "$lib/MailboxRefresh.svelte";
  import Toast from "$lib/Toast.svelte";
  import DraftList from "$lib/DraftList.svelte";
  import MailboxCleanup from "$lib/MailboxCleanup.svelte";
  import {page} from "$app/state";
  import Icon from "$lib/Icon.svelte";
  import MailboxEmptyState from "$lib/MailboxEmptyState.svelte";
  import MessageListRow from "$lib/MessageListRow.svelte";
  import ContactAddress from "$lib/ContactAddress.svelte";
  import {showInboxHeaders, loadHeaderPreference} from "$lib/preferences.js";
  import DateTime from "$lib/DateTime.svelte";
  import {onMount} from 'svelte';
  let ready=$state(false);onMount(()=>{ready=true;loadHeaderPreference();});
  import {afterNavigate,invalidateAll} from '$app/navigation';
  import {mailboxRequest} from '$lib/mailbox.js';
  import SelectionAvatar from '$lib/SelectionAvatar.svelte';
  import SelectionActions from '$lib/SelectionActions.svelte';
  let {data:loaded}=$props();
  let draftSelection=$state(false);
  let cleanupLocked=$state(false);
  const mailbox = mailboxView(()=>loaded, ()=>page.url, ()=>selected.length > 0 || draftSelection || cleanupLocked);
  let data=$derived(mailbox.data);
  let selected=$state<string[]>([]),busy=$state(false),status=$state('');
  const key=(message:{sender:string;messageId:string})=>'received/'+message.sender+'/'+message.messageId;
  const sentKey=(message:{kind:string;messageId:string})=>'sent/'+message.kind+'/'+message.messageId;
  let messages=$derived([
    ...data.messages.map(message=>({type:'received' as const,key:key(message),timestamp:message.deliveredAt,message})),
    ...data.sent.messages.map(message=>({type:'sent' as const,key:sentKey(message),timestamp:message.createdAt,message})),
  ].sort((a,b)=>Date.parse(b.timestamp)-Date.parse(a.timestamp)));
  let selectedMessages=$derived(messages.filter(item=>selected.includes(item.key)));
  afterNavigate(()=>selected=[]);
  function toggle(id:string){selected=selected.includes(id)?selected.filter(value=>value!==id):[...selected,id];}
  async function restore(){
    busy=true;status='';
    let restored=0;
    try{
      const received=selectedMessages.filter(item=>item.type==='received');
      for(const item of received){
        await restoreReceivedMessage(item.message.sender,item.message.messageId);
        restored++;
        selected=selected.filter(id=>id!==item.key);
      }
      for(const item of selectedMessages){
        if(item.type!=='sent')continue;
        const result=await mailboxRequest('HailMailbox/restoreSent',{input:{kind:item.message.kind,messageId:item.message.messageId}});
        if(typeof result.restored!=='number'||!Number.isSafeInteger(result.restored))throw new Error('Invalid restore result');
        restored+=result.restored;
        selected=selected.filter(id=>id!==item.key);
      }
      status=`Restored ${restored} message(s) to their original folders.`;
    }catch(e){status=`Restored ${restored} message(s). ${e instanceof Error?e.message:'Unable to restore remaining messages.'}`;}
    finally{
      try{await invalidateAll();}catch{status+=' Unable to refresh Trash. Refresh the page to see current messages.';}
      busy=false;
    }
  }
</script>
<svelte:head><title>Trash · {page.data.branding?.name ?? "Hail"}</title></svelte:head>
<div class="trash-list min-w-0 pb-28 min-[901px]:pb-0" class:has-selection={selectedMessages.length>0}>
  <MailboxRefresh view={mailbox} locked={selected.length > 0 || draftSelection || cleanupLocked}>
    {#snippet heading()}<MailboxCleanup onlockchange={active=>cleanupLocked=active} folder="Trash" trashEnabled={data.trashEnabled} empty={!data.messages.length&&!data.sent.messages.length&&!data.paged&&!data.sentPaged&&!data.drafts.drafts.length&&!data.draftPaged} />{/snippet}
  </MailboxRefresh>
  {#if status}<Toast message={status} />{/if}
  {#if messages.length}
    {#if selectedMessages.length}
      <SelectionActions label="Trash actions" count={selectedMessages.length} locked={busy} {busy} onclear={()=>selected=[]} onselectall={selectedMessages.length<messages.length?()=>selected=messages.map(item=>item.key):undefined}>
        {#snippet actions()}<button class="hail-icon-button" type="button" aria-label="Restore selected messages" title="Restore selected messages" disabled={busy||!ready} onclick={restore}><Icon name="restore" /></button>{/snippet}
      </SelectionActions>
    {/if}
    <section class="compact-list" aria-label="Trashed messages">
      {#each messages as item (item.key)}
        {@const message=item.message}
        {#if item.type==='received'}
          <MessageListRow inline muted href={`/message/${encodeURIComponent(item.message.sender)}/${encodeURIComponent(message.messageId)}`} timestamp={item.timestamp} title={message.title} preview={message.preview} header={$showInboxHeaders ? message.header : null} selected={selected.includes(item.key)}>
            {#snippet leading()}<SelectionAvatar name={item.message.relayed?(item.message.relayed.fromName??item.message.relayed.fromAddress):item.message.senderAddress??item.message.sender} avatar={item.message.relayed?null:item.message.avatar} selected={selected.includes(item.key)} disabled={busy||!ready} label={`Select message from ${item.message.senderAddress??item.message.sender}`} ontoggle={()=>toggle(item.key)} />{/snippet}
            {#snippet sender()}<MessageSender owner={data.account.did} did={item.message.sender} address={item.message.senderAddress} relayed={item.message.relayed} />{/snippet}
            {#snippet details()}Trashed <DateTime format="list" value={item.message.trashedAt} />{/snippet}
          </MessageListRow>
        {:else}
          <MessageListRow inline muted href={`/sent/send/${item.message.kind}/${message.messageId}?trash=true`} timestamp={item.timestamp} title={message.title} preview={message.preview} header={$showInboxHeaders ? message.header : null} selected={selected.includes(item.key)}>
            {#snippet leading()}<SelectionAvatar name={Array.from(data.account.address)[0]??''} selected={selected.includes(item.key)} disabled={busy||!ready} label={`Select sent message: ${message.title}`} ontoggle={()=>toggle(item.key)} />{/snippet}
            {#snippet sender()}{item.message.recipientSummary?.address??item.message.recipientSummary?.did??(item.message.kind==='category'?item.message.category:'Multiple recipients')}{/snippet}
            {#snippet details()}Trashed {#if item.message.trashedAt}<DateTime format="list" value={item.message.trashedAt} />{/if}{/snippet}
          </MessageListRow>
        {/if}
      {/each}
    </section>
  {:else if !data.drafts.drafts.length}<MailboxEmptyState icon="trash" title="Must be pickup day." />{/if}
  {#if data.drafts.drafts.length}<section class="mt-6"><h2 class="text-sm text-muted">Drafts</h2><DraftList onselection={active=>draftSelection=active} drafts={data.drafts.drafts} trash address={data.account.address}/></section>{/if}
  {#if data.draftPaged||data.drafts.next}<nav class="mt-6 flex gap-3" aria-label="Trashed draft pages">{#if data.draftPaged}<a href="/trash">Newest drafts</a>{/if}{#if data.drafts.next}<button disabled={mailbox.busy||mailbox.pending||selected.length > 0} onclick={()=>mailbox.older("draftAfter",data.drafts.next)}>{mailbox.batches >= 4 ? "Continue to older history" : "Load older drafts"}</button>{/if}</nav>{/if}
  {#if data.sentPaged||data.sent.next}<nav class="mt-6 flex gap-3" aria-label="Trashed sent pages">{#if data.sentPaged}<a href="/trash">Newest sent messages</a>{/if}{#if data.sent.next}<button disabled={mailbox.busy||mailbox.pending||selected.length > 0} onclick={()=>mailbox.older("sentAfter",data.sent.next)}>{mailbox.batches >= 4 ? "Continue to older history" : "Load older sent messages"}</button>{/if}</nav>{/if}
  {#if data.paged||data.next}<nav class="mt-6 flex gap-3" aria-label="Trash pages">{#if data.paged}<a class="hail-button-secondary" href="/trash">Newest messages</a>{/if}{#if data.next}<button class="hail-button-secondary" disabled={mailbox.busy||mailbox.pending||selected.length > 0} onclick={()=>mailbox.older("after",data.next)}>{mailbox.batches >= 4 ? "Continue to older history" : "Load older"}</button>{/if}</nav>{/if}
</div>

<style lang="postcss">
  @reference "../../app.css";

  @media (max-width:900px) {
    .trash-list:has(:global(.selection-actions)) :global(.mobile-cleanup) { @apply hidden; }
    .trash-list:has(:global(.selection-actions)) { @apply pb-[180px]; }
  }
</style>
