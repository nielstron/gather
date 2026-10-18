<script lang="ts">
  import { createEventDispatcher, tick } from 'svelte';
  import Icon from './Icon.svelte';
  export let field: string;
  export let direction: string;
  export let relevanceLabel = '';
  export let label = '';
  const dispatch = createEventDispatcher<{ change: { field: string; direction: string } }>();
  let open = false;
  let root: HTMLDivElement;
  let trigger: HTMLButtonElement;

  function choose(nextField: string, nextDirection: string) {
    dispatch('change', { field: nextField, direction: nextDirection });
  }
  function outside(event: Event) {
    if (open && event.target instanceof Node && !root.contains(event.target)) open = false;
  }
  async function keyboard(event: KeyboardEvent) {
    if (!root?.contains(document.activeElement)) return;
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); open = false; trigger.focus(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    if (!open) { open = true; await tick(); }
    const items = [...root.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowDown' ? (current + 1) % items.length : current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
    items[index]?.focus();
  }
</script>

<svelte:window on:click={outside} on:focusin={outside} on:keydown={keyboard} />
<div class="sort-picker" bind:this={root}>
  <button class="icon-button" bind:this={trigger} aria-label="Sort photos" aria-haspopup="menu" aria-expanded={open} aria-controls="photo-sort-menu" title={`Sort by: ${label}`} on:click={() => { open = !open; }}><Icon name={direction === 'asc' ? 'sort-ascending' : 'sort-descending'} size={20} /></button>
  {#if open}
    <div id="photo-sort-menu" class="sort-menu" role="menu" aria-label="Sort photos">
      <div role="group" aria-label="Direction">
        <span class="group-label">Direction</span>
        <button role="menuitemradio" aria-checked={direction === 'asc'} on:click={() => choose(field, 'asc')}><Icon name="sort-ascending" size={18} /><span>Ascending</span>{#if direction === 'asc'}<Icon name="check" size={17} />{/if}</button>
        <button role="menuitemradio" aria-checked={direction === 'desc'} on:click={() => choose(field, 'desc')}><Icon name="sort-descending" size={18} /><span>Descending</span>{#if direction === 'desc'}<Icon name="check" size={17} />{/if}</button>
      </div>
      <div role="group" aria-label="Sort by" class="sort-fields">
        <span class="group-label">Sort by</span>
        <button role="menuitemradio" aria-checked={field === 'name'} on:click={() => choose('name', direction)}><Icon name="image" size={18} /><span>Filename</span>{#if field === 'name'}<Icon name="check" size={17} />{/if}</button>
        <button role="menuitemradio" aria-checked={field === 'newest'} on:click={() => choose('newest', direction)}><Icon name="clock" size={18} /><span>Date/time</span>{#if field === 'newest'}<Icon name="check" size={17} />{/if}</button>
        {#if relevanceLabel}<button role="menuitemradio" aria-checked={field === 'relevance'} on:click={() => choose('relevance', direction)}><Icon name="spark" size={18} /><span>{relevanceLabel}</span>{#if field === 'relevance'}<Icon name="check" size={17} />{/if}</button>{/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .sort-picker{position:relative;flex-shrink:0}.sort-menu{position:absolute;right:0;top:calc(100% + 8px);z-index:35;width:216px;padding:7px;background:#fff;border:1px solid var(--border);border-radius:11px;box-shadow:0 8px 30px #27203b24;color:#514c60}.group-label{display:block;padding:7px 10px 4px;font-size:10px;font-weight:650;letter-spacing:.06em;text-transform:uppercase;color:#93909d}.sort-menu button{display:flex;align-items:center;gap:10px;width:100%;min-height:38px;border-radius:6px;padding:8px 10px;text-align:left;font-size:12px;color:inherit}.sort-menu button>span{flex:1}.sort-menu button:hover,.sort-menu button:focus-visible{background:#f3f0fc}.sort-menu button[aria-checked=true]{color:var(--accent)}.sort-fields{margin-top:6px;padding-top:6px;border-top:1px solid var(--border)}
</style>
