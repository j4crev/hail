<script lang="ts">
  import {onMount} from 'svelte';
  import {pushStatus,enablePush,disablePush} from './push.js';
  let status=$state<Awaited<ReturnType<typeof pushStatus>>|null>(null),busy=$state(false),error=$state(''),waitingSince=$state(0),timedOut=$state(false);
  let checking=false;
  async function refresh(){
    if(checking||busy)return;checking=true;
    try{
      status=await pushStatus();
      if(status.pending){waitingSince ||= Date.now();timedOut=Date.now()-waitingSince>=60_000;}
      else{waitingSince=0;timedOut=false;if(status.enabled)error='';}
    }catch{error='Unable to check notifications. Try again.';}finally{checking=false;}
  }
  onMount(()=>{
    void refresh();
    // Bounded polling catches completion even if the worker message was missed.
    const timer=setInterval(()=>{if(status?.pending&&!status.verificationError&&!timedOut&&document.visibilityState==='visible')void refresh();},3000);
    const message=(event:MessageEvent)=>{
      if(event.data?.type!=='hail-push-verification')return;
      if(event.data.ok===false)error=event.data.reason==='http'&&Number.isInteger(event.data.httpStatus)?
        `The browser received the verification, but Hail refused its reply (HTTP ${event.data.httpStatus}).`:
        'The browser received the verification, but could not confirm it with Hail.';
      void refresh();
    };
    navigator.serviceWorker?.addEventListener('message',message);
    return()=>{clearInterval(timer);navigator.serviceWorker?.removeEventListener('message',message);};
  });
  async function change(retry=false){
    if(!status?.capability||busy)return;busy=true;error='';waitingSince=0;timedOut=false;
    try{
      if(status.enabled||status.pending)await disablePush();
      if(retry||!status.enabled&&!status.pending)await enablePush(status.capability);
    }catch(e){error=e instanceof Error?e.message:'Unable to update notifications.';}
    finally{busy=false;await refresh();}
  }
</script>
{#if status?.available}
  <div class="border-0 border-t border-solid border-line pt-6 grid gap-3">
    <strong class="text-sm">Browser notifications</strong>
    <p class="m-0 text-sm text-muted">Get a private notification when your mailbox changes. Message content is never shown. Enable again after signing in or when the seven-day subscription expires.</p>
    <p class="m-0 text-sm" role="status">{status.enabled?'Enabled for this sign-in.':status.verificationError==='pushServiceRejected'?'The push service rejected verification.':status.verificationError?'Verification could not be delivered.':status.pending?(timedOut?'Verification has not completed. Try again to create a fresh request.':'Waiting for browser verification…'):'Off for this sign-in.'}</p>
    <div class="flex gap-3">
      <button class="hail-button-secondary" disabled={busy} onclick={()=>change()}>{status.enabled||status.pending?'Turn off':'Enable notifications'}</button>
      {#if status.pending}
        <button class="hail-button-secondary" disabled={busy} onclick={refresh}>Check verification</button>
        {#if status.verificationError||timedOut||error}<button class="hail-button-secondary" disabled={busy} onclick={()=>change(true)}>Try again</button>{/if}
      {/if}
    </div>
    {#if error}<p class="text-sm text-danger" role="alert">{error}</p>{/if}
  </div>
{/if}
