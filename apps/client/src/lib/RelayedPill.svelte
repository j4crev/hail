<script lang="ts">
  let {authenticated = true}: {authenticated?: boolean} = $props();
</script>
<span class="relayed-pill inline-flex shrink-0 items-center rounded-full px-2.5 py-1.5 text-xs font-semibold [background:light-dark(#fef3c7,#422006)] [color:light-dark(#92400e,#fde68a)]"
  title={authenticated ? "Relayed from email. The email sender's domain signed it." : "Relayed from email. The sender could not be verified."}>Via email{#if !authenticated}<span class="sr-only">, sender not verified</span>{/if}</span>
