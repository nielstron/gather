<script lang="ts">
  import { page } from '$app/stores';
  import { base } from '$app/paths';
  import { collectionBase } from '$lib/collection-path';
  import '../app.css';
  import 'photoswipe/style.css';
  let { children } = $props();
</script>

{#key collectionBase($page.url.pathname, base)}
  {@render children()}
{/key}
