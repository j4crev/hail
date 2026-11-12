<script lang="ts">
  let {authenticated = true}: {authenticated?: boolean} = $props();
</script>
<span class="relayed-pill inline-flex shrink-0 items-center rounded-full bg-brand-soft px-2.5 py-1.5 text-xs font-semibold text-brand-strong"
  title={authenticated ? "Relayed from email. The email sender's domain signed it." : "Relayed from email. The sender could not be verified."}>via email{#if !authenticated}<span class="sr-only">, sender not verified</span>{/if}</span>
