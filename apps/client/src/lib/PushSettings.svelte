<script lang="ts">
  import {onMount} from 'svelte';
  import {pushStatus,enablePush,disablePush} from './push.js';
  let status=$state<Awaited<ReturnType<typeof pushStatus>>|null>(null),busy=$state(false),error=$state('');
  onMount(()=>{void pushStatus().then(value=>status=value).catch(()=>{});});
  async function change(){
    if(!status?.capability)return;busy=true;error='';
    try{if(status.enabled||status.pending)await disablePush();else await enablePush(status.capability);status=await pushStatus();}
    catch(e){error=e instanceof Error?e.message:'Unable to update notifications.';}finally{busy=false;}
  }
  async function refresh(){busy=true;error='';try{status=await pushStatus();}catch{error='Unable to check notifications.';}finally{busy=false;}}
</script>
{#if status?.available}
  <div class="border-0 border-t border-solid border-line pt-6 grid gap-3">
    <strong class="text-sm">Browser notifications</strong>
    <p class="m-0 text-sm text-muted">Get a private notification when your mailbox changes. Message content is never shown. Enable again after signing in or when the seven-day subscription expires.</p>
    <p class="m-0 text-sm" role="status">{status.enabled?'Enabled for this sign-in.':status.pending?'Waiting for browser verification.':'Off for this sign-in.'}</p>
    <div class="flex gap-3">
      <button class="hail-button-secondary" disabled={busy} onclick={change}>{status.enabled||status.pending?'Turn off':'Enable notifications'}</button>
      {#if status.pending}<button class="hail-button-secondary" disabled={busy} onclick={refresh}>Check verification</button>{/if}
    </div>
    {#if error}<p class="text-sm text-danger" role="alert">{error}</p>{/if}
  </div>
{/if}
