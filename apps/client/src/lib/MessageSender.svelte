<script lang="ts">
  import ContactAddress from "$lib/ContactAddress.svelte";
  import type {RelayedOrigin} from "$lib/messages.js";
  // A relayed message names its email sender first; the Hail sender is the relay.
  let {owner, did, address, relayed = null}: {owner: string; did: string; address: string | null; relayed?: RelayedOrigin | null} = $props();
</script>
{#if relayed}<span class="address" title={`${relayed.fromAddress}, via email`}>{relayed.fromName ?? relayed.fromAddress}</span> <span class="relayed-note font-[450] text-muted">via email</span>
{:else}<ContactAddress {owner} {did} {address} />{/if}
