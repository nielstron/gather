<script lang="ts">
  import { base as appBase } from '$app/paths';
  import { page } from '$app/stores';
  import { collectionBase } from '$lib/collection-path';
  $: base = collectionBase($page.url.pathname, appBase);
  import { createEventDispatcher, onDestroy, tick } from 'svelte';
  import Thumbnail from './Thumbnail.svelte';
  import Icon from './Icon.svelte';
  import { searchFields, operators, operatorLabels, validateSearch, type CollectionSearch, type SearchPerson } from '$lib/search';
  export let query = '';
  export let visible = false;
  export let value: CollectionSearch = { mode: 'semantic' };
  const dispatch = createEventDispatcher<{ apply: CollectionSearch }>();
  type Row = { id: number; field: string; op: string; value: string; empty: boolean };
  let open = false;
  let openedFromPeople = false;
  let peopleInput: HTMLInputElement;
  let modeInput: HTMLSelectElement;
  $: if (!visible) open = false;
  let mode: CollectionSearch['mode'] = value.mode;
  let groups: Row[][] = [[]];
  let sequence = 0;
  let people: SearchPerson[] = [];
  let selectedPeople: string[] = [];
  let peopleMatch = 'all';
  let peopleQuery = '';
  let peopleLoading = false;
  let peopleLoaded = false;
  let peopleError = '';
  let formError = '';
  let language = '';
  let queryAssetId = '';
  let resultLimit = 1000;
  let withStacked = true;
  let orderField = '';
  let orderDirection: 'asc' | 'desc' = 'desc';
  let controller: AbortController | undefined;
  $: if (visible && !peopleLoaded && !peopleLoading && !peopleError) void loadPeople();
  $: semanticActive = mode === 'semantic' && !!(query.trim() || queryAssetId.trim());
  $: filterCount = Object.keys(value.filter || {}).length;
  $: visiblePeople = people.filter(person => (person.name || 'Unnamed person').toLowerCase().includes(peopleQuery.toLowerCase()));

  async function loadPeople() {
    if (peopleLoading) return;
    peopleLoading = true; peopleError = '';
    controller?.abort(); controller = new AbortController();
    try {
      const response = await fetch(`${base}/api/search/people`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(25_000)]) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'People could not be loaded.');
      people = body.people; peopleLoaded = true;
    } catch (error) { if (!controller.signal.aborted) peopleError = error instanceof Error ? error.message : 'People could not be loaded.'; }
    finally { peopleLoading = false; }
  }
  async function showFilters(peopleFirst = false) {
    if (open && openedFromPeople === peopleFirst) { open = false; return; }
    open = true; openedFromPeople = peopleFirst;
    if (!peopleLoaded) void loadPeople();
    await tick();
    if (!open) return;
    (peopleFirst ? peopleInput : modeInput)?.focus({ preventScroll: true });
  }
  function addRow(group: number) { groups = groups.map((rows, index) => index === group ? [...rows, { id: ++sequence, field: 'takenAt', op: 'gte', value: '', empty: false }] : rows); }
  function removeRow(group: number, id: number) { groups = groups.map((rows, index) => index === group ? rows.filter(row => row.id !== id) : rows); }
  function changeField(row: Row) { row.op = operators(searchFields.find(field => field.key === row.field)!)[0]; row.value = ''; row.empty = false; groups = [...groups]; }
  function togglePerson(id: string) { selectedPeople = selectedPeople.includes(id) ? selectedPeople.filter(person => person !== id) : [...selectedPeople, id]; }
  function buildBranch(rows: Row[]) {
    const branch: Record<string, Record<string, unknown>> = {};
    for (const row of rows) {
      const field = searchFields.find(field => field.key === row.field)!;
      if (!row.empty && !row.value.trim()) throw new Error(`Enter a value for ${field.label}.`);
      const convert = (text: string) => field.kind === 'number' ? Number(text) : field.kind === 'boolean' ? text === 'true' : field.kind === 'date' ? new Date(text).toISOString() : text;
      const list = ['in', 'notIn', 'all', 'any', 'none'].includes(row.op);
      const operand = row.empty ? null : list ? row.value.split(',').map(text => convert(text.trim())) : convert(row.value.trim());
      if (branch[row.field]?.[row.op] !== undefined) throw new Error(`Combine values for ${field.label} in one condition, or add an alternative group.`);
      branch[row.field] = { ...branch[row.field], [row.op]: operand };
    }
    return branch;
  }
  function apply() {
    try {
      const filter: Record<string, unknown> = buildBranch(groups[0]);
      if (selectedPeople.length) {
        if (filter.personIds) throw new Error('Choose people in the face picker or the conditions, rather than both.');
        filter.personIds = { [peopleMatch]: selectedPeople };
      }
      const alternatives = groups.slice(1).filter(rows => rows.length).map(buildBranch);
      if (alternatives.length) filter.or = alternatives;
      const options = validateSearch({ mode, ...(Object.keys(filter).length ? { filter } : {}),
        ...(mode === 'semantic' ? { resultLimit, ...(language.trim() ? { language: language.trim() } : {}), ...(queryAssetId.trim() ? { queryAssetId: queryAssetId.trim() } : {}) } : {}),
        ...(!withStacked ? { withStacked: false } : {}),
        ...(!semanticActive && orderField ? { orderBy: { field: orderField, direction: orderDirection } } : {}) });
      value = options; formError = ''; dispatch('apply', options); open = false;
    } catch (error) { formError = error instanceof Error ? error.message : 'Check your filters.'; }
  }
  export function reset() {
    groups = [[]]; selectedPeople = []; language = ''; queryAssetId = ''; resultLimit = 1000; withStacked = true; orderField = ''; mode = 'semantic';
    formError = ''; value = { mode: 'semantic' }; dispatch('apply', value);
  }
  onDestroy(() => controller?.abort());
</script>

{#if visible}
<div class="search-tools" aria-label="Search tools">
  <button class="filter-toggle" class:active={filterCount > 0} on:click={() => showFilters()} aria-expanded={open} aria-controls="search-filters"><Icon name="filter" size={18} />Filters{#if filterCount}<span>{filterCount}</span>{/if}</button>
  <button class="filter-toggle" class:active={!!value.filter?.personIds} on:click={() => showFilters(true)} aria-expanded={open} aria-controls="search-filters"><Icon name="people" size={18} />People</button>
  <span class="search-mode-note"><Icon name={value.mode === 'semantic' ? 'spark' : 'search'} size={15} />{value.mode === 'semantic' ? 'Search by meaning' : value.mode === 'filename' ? 'Search by filename' : 'Search descriptions'}</span>
  {#if filterCount || value.mode !== 'semantic' || value.queryAssetId}<button class="text-button" on:click={reset}>Clear filters</button>{/if}
</div>
{#if open}
  <form id="search-filters" class="search-filters" on:submit|preventDefault={apply}>
    <header><div><h2>Search this collection</h2><p>Describe a scene, find a face, or combine filters.</p></div><button type="button" class="icon-button" on:click={() => { open = false; }} aria-label="Close search filters"><Icon name="close" /></button></header>
    <label class="filter-label">Search mode<select aria-label="Search mode" bind:this={modeInput} bind:value={mode}><option value="semantic">Semantic · scenes and context (CLIP)</option><option value="filename">Filename and contributor</option><option value="metadata">Description text</option></select></label>
    <section class="people-filter" aria-label="People filter">
      <div class="filter-heading"><h3><Icon name="people" size={19} />People in these photos</h3><button class="text-button" type="button" on:click={loadPeople} disabled={peopleLoading}>Refresh people</button></div>
      <div class="people-controls"><input type="search" aria-label="Find a person" bind:this={peopleInput} placeholder="Find a person…" bind:value={peopleQuery} /><label class="filter-label">Match<select aria-label="People match" bind:value={peopleMatch}><option value="all">All selected people</option><option value="any">Any selected person</option><option value="none">Exclude selected people</option></select></label></div>
      {#if peopleLoading && !peopleLoaded}<p class="filter-help" role="status">Loading people…</p>{:else if peopleError}<p class="error-text" role="alert">{peopleError}</p>{:else if !people.length}<p class="filter-help">No recognized people in this collection yet. Faces appear after Immich finishes face recognition.</p>{:else}
        <div class="people-options">{#each visiblePeople as person (person.id)}<button type="button" class="face-option" class:chosen={selectedPeople.includes(person.id)} aria-pressed={selectedPeople.includes(person.id)} aria-label={`${person.name || 'Unnamed person'} (${person.count} photos)`} on:click={() => togglePerson(person.id)}><span class="face-image"><Icon name="user" size={25} /><Thumbnail src={`${base}/api/search/people/${person.id}/thumbnail`} alt="" /></span><span>{person.name || 'Unnamed person'}<small>{person.count} {person.count === 1 ? 'photo' : 'photos'}</small></span>{#if selectedPeople.includes(person.id)}<Icon name="check" size={18} />{/if}</button>{/each}</div>
        {#if !visiblePeople.length}<p class="filter-help">No people match that name.</p>{/if}
      {/if}
      {#if selectedPeople.length}<p class="filter-help">{selectedPeople.length} selected <button type="button" class="text-button" on:click={() => { selectedPeople = []; }}>Clear people</button></p>{/if}
    </section>
    <section aria-label="Search conditions">
      <h3>Conditions</h3><p class="filter-help">All conditions must match. Alternative groups match any one group, together with the main conditions.</p>
      {#each groups as rows, group}
        <div class="condition-group"><strong>{group === 0 ? 'All of these' : `Alternative ${group}`}</strong>
          {#each rows as row (row.id)}
            {@const field = searchFields.find(field => field.key === row.field)!}
            <div class="condition-row">
              <select aria-label="Filter field" bind:value={row.field} on:change={() => changeField(row)}>{#each searchFields as field}<option value={field.key}>{field.label}</option>{/each}</select>
              <select aria-label="Filter operator" bind:value={row.op}>{#each operators(field) as op}<option value={op}>{operatorLabels[op]}</option>{/each}</select>
              {#if field.kind === 'boolean'}<select aria-label="Filter value" bind:value={row.value}><option value="">Choose…</option><option value="true">Yes</option><option value="false">No</option></select>
              {:else if field.kind === 'enum' && !['in', 'notIn'].includes(row.op)}<select aria-label="Filter value" bind:value={row.value}><option value="">Choose…</option>{#each field.values || [] as option}<option value={option}>{option}</option>{/each}</select>
              {:else}<input aria-label="Filter value" type={field.kind === 'date' ? 'datetime-local' : 'text'} inputmode={field.kind === 'number' ? 'decimal' : 'text'} step="any" bind:value={row.value} disabled={row.empty} placeholder={['in', 'notIn', 'all', 'any', 'none'].includes(row.op) ? 'Comma-separated values' : field.kind === 'ids' || field.kind === 'uuid' ? 'Immich ID' : 'Value'} />{/if}
              {#if field.nullable && ['eq', 'ne'].includes(row.op)}<label class="empty-filter"><input type="checkbox" bind:checked={row.empty} />Empty</label>{/if}
              <button type="button" class="icon-button" aria-label="Remove condition" on:click={() => removeRow(group, row.id)}><Icon name="close" size={17} /></button>
            </div>
          {/each}
          <button type="button" class="text-button" on:click={() => addRow(group)}>+ Add condition</button>
          {#if group > 0}<button type="button" class="text-button" on:click={() => { groups = groups.filter((_, index) => index !== group); }}>Remove alternative</button>{/if}
        </div>
      {/each}
      <button type="button" class="text-button" on:click={() => { groups = [...groups, []]; }}>+ Add alternative group</button>
    </section>
    <details><summary>More search options</summary><div class="more-search-options">
      {#if mode === 'semantic'}<label class="filter-label">Search language<input placeholder="Auto (or en, de, fr…)" bind:value={language} /></label><label class="filter-label">Similar to an image in this collection<input placeholder="Immich asset ID" bind:value={queryAssetId} /></label><label class="filter-label">Maximum semantic results<input type="number" min="1" max="1000" bind:value={resultLimit} /></label>{/if}
      {#if !semanticActive}<label class="filter-label">Metadata result order<select aria-label="Metadata result order" bind:value={orderField}><option value="">Gallery order / semantic relevance</option><option value="fileCreatedAt">File creation date</option><option value="localDateTime">Local date taken</option><option value="fileSizeInBytes">File size</option><option value="rating">Rating</option></select></label>
      {#if orderField}<label class="filter-label">Direction<select bind:value={orderDirection}><option value="desc">Descending</option><option value="asc">Ascending</option></select></label>{/if}
      <label class="empty-filter"><input type="checkbox" bind:checked={withStacked} />Include all photos in stacks (metadata searches)</label>{/if}
    </div></details>
    {#if formError}<p class="error-text" role="alert">{formError}</p>{/if}
    <footer><button type="button" class="text-button" on:click={reset}>Reset search filters</button><button type="submit" class="apply-filters"><Icon name="search" size={17} />Apply filters</button></footer>
  </form>
{/if}

{/if}

<style>
  .search-tools{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin:0;padding:12px 0;font-size:12px}.filter-toggle{display:flex;align-items:center;gap:8px;padding:9px 12px;border:1px solid var(--border);border-radius:8px;background:white;color:var(--text)}.filter-toggle.active{color:var(--accent);background:#f0edff}.filter-toggle>span{border-radius:10px;padding:1px 6px;background:#e5dfff}.search-mode-note{display:flex;align-items:center;gap:5px;color:#777582}.search-filters{border:1px solid var(--border);border-radius:14px;padding:22px;margin:0 0 16px;background:#faf9fd;display:grid;gap:22px;font-size:13px}.search-filters header,.filter-heading,.search-filters footer{display:flex;align-items:center;justify-content:space-between;gap:12px}.search-filters h2{font-size:19px}.search-filters h3{font-size:14px;margin:0 0 8px;display:flex;align-items:center;gap:6px}.search-filters header p,.filter-help{color:#777582;font-size:12px;line-height:1.6;margin-top:5px}.filter-label{display:flex;flex-direction:column;gap:7px;font-size:12px;color:#666370}.search-filters input:not([type=checkbox]),.search-filters select{border:1px solid #dedbe7;border-radius:7px;background:#fff;color:#393641;padding:9px 10px;min-height:38px;width:100%}.people-controls{display:flex;align-items:end;gap:12px}.people-controls>input{flex:1}.people-controls>label{flex:1}.people-options{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:8px;max-height:290px;overflow-y:auto;margin-top:12px;padding:3px}.face-option{display:flex;align-items:center;gap:10px;text-align:left;background:white;border:1px solid #e4e0eb;border-radius:10px;padding:8px;color:#53505e;font-size:12px}.face-option.chosen{border-color:var(--accent);background:#f0edff;color:var(--accent)}.face-option>span:nth-child(2){flex:1;min-width:0;overflow-wrap:anywhere}.face-option small{display:block;color:#8b8795;font-size:10px;margin-top:3px}.face-image{display:flex;align-items:center;justify-content:center;position:relative;width:42px;height:42px;flex-shrink:0;border-radius:50%;overflow:hidden;background:#ece9f5}.face-image :global(svg){position:absolute}.face-image :global(img:not([src])){visibility:hidden}.face-image :global(img){position:relative;width:100%;height:100%;object-fit:cover}.condition-group{border:1px solid #e4e0eb;padding:12px;border-radius:8px;margin-top:12px}.condition-group>strong{font-size:11px;color:#85808d}.condition-row{display:flex;align-items:center;gap:8px;margin:10px 0}.condition-row>select{flex:1}.condition-row>input{flex:1.4}.empty-filter{display:flex;align-items:center;gap:6px;white-space:nowrap;font-size:12px}.more-search-options{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin-top:16px}summary{cursor:pointer;color:#696273}.apply-filters{display:flex;align-items:center;gap:7px;color:white;background:var(--accent);padding:10px 16px;border-radius:8px}.search-filters .text-button{font-size:12px}.search-filters footer{border-top:1px solid #e4e0eb;padding-top:16px} @media(max-width:600px){.search-filters{padding:14px}.condition-row{flex-wrap:wrap}.condition-row>select{flex:1 1 40%}.condition-row>input{flex:1 1 65%}.more-search-options{grid-template-columns:1fr}.search-mode-note{font-size:11px}.people-controls{flex-direction:column;align-items:stretch}}
</style>
