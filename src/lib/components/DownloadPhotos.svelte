<script lang="ts">
  import { onDestroy } from 'svelte';
  import { modalHistory } from '$lib/modal-history';
  import Icon from './Icon.svelte';
  export let base: string;
  export let selfFolder: string;
  type Contributor = { folder: string; name: string; count: number; bytes: number; updates: number; updatedBytes: number };
  let dialog: HTMLDialogElement;
  let contributors: Contributor[] = [];
  let selected: string[] = [];
  let ids: string[] | undefined;
  let updatesOnly = false, loading = false, started = false, error = '';
  let controller: AbortController | undefined;
  $: selectedContributors = contributors.filter(person => selected.includes(person.folder));
  $: count = selectedContributors.reduce((sum, person) => sum + (updatesOnly ? person.updates : person.count), 0);
  $: totalBytes = selectedContributors.reduce((sum, person) => sum + (updatesOnly ? person.updatedBytes : person.bytes), 0);
  $: options = JSON.stringify({ folders: selected, updatesOnly, ...(ids ? { ids } : {}) });
  function bytes(size: number) { return size >= 1024 ** 3 ? `${(size / 1024 ** 3).toFixed(1)} GB` : size >= 1024 ** 2 ? `${(size / 1024 ** 2).toFixed(1)} MB` : `${Math.ceil(size / 1024)} KB`; }
  export async function open(selection?: string[]) {
    ids = selection; updatesOnly = false; started = false; error = ''; contributors = []; selected = [];
    if (!dialog.open) dialog.showModal();
    controller?.abort(); controller = new AbortController(); loading = true;
    const signal = controller.signal;
    try {
      const response = await fetch(`${base}/api/download/options`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ids ? { ids } : {}), signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Download options could not be loaded.');
      if (signal.aborted) return;
      contributors = body.contributors;
      selected = contributors.filter(person => person.count && person.folder !== selfFolder.toLowerCase()).map(person => person.folder);
    } catch (cause) { if (!signal.aborted) error = cause instanceof Error ? cause.message : 'Download options could not be loaded.'; }
    finally { if (!signal.aborted) loading = false; }
  }
  async function startDownload() {
    if (!count || started) return;
    error = ''; started = true;
    try {
      const response = await fetch(`${base}/api/download/prepare`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: options, signal: AbortSignal.timeout(15_000) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'The download could not be started.');
      const link = document.createElement('a');
      link.href = `${base}/api/download?ticket=${encodeURIComponent(body.ticket)}`;
      link.download = 'gather-photos.zip';
      dialog.append(link); link.click(); link.remove();
    } catch (cause) { error = cause instanceof Error ? cause.message : 'The download could not be started.'; started = false; }
  }
  onDestroy(() => controller?.abort());
</script>

<dialog use:modalHistory class="download-dialog" bind:this={dialog} aria-labelledby="download-heading">
  <header><div><h2 id="download-heading">Download photos</h2><p>{ids ? `${ids.length} selected photos` : 'Choose whose photos to download.'}</p></div><button class="icon-button" aria-label="Close download options" on:click={() => dialog.close()}><Icon name="close" /></button></header>
  {#if loading}<p role="status">Loading contributors…</p>{:else}
    <form on:submit|preventDefault={startDownload}>
      <fieldset disabled={started}><legend>Photos from</legend>
        <div class="contributor-actions"><button type="button" class="text-button" on:click={() => selected = contributors.filter(person => person.count).map(person => person.folder)}>Select all contributors</button><button type="button" class="text-button" on:click={() => selected = []}>Deselect all contributors</button></div>
        <div class="download-contributors">{#each contributors as person (person.folder)}<label class:empty={!person.count}><input type="checkbox" bind:group={selected} value={person.folder} disabled={!person.count} aria-label={`${person.name}${person.folder === selfFolder.toLowerCase() ? ' (you)' : ''}`} /><span>{person.name}{#if person.folder === selfFolder.toLowerCase()} <small>(you)</small>{/if}</span><small>{person.count} {person.count === 1 ? 'photo' : 'photos'}</small></label>{/each}</div>
        <label class="download-updates"><input type="checkbox" bind:checked={updatesOnly} /><span>Only updates since last download</span></label>
        <p class="download-help">Includes photos you haven’t downloaded yet and changed originals.</p>
      </fieldset>
      {#if error}<p class="error-text" role="alert">{error}</p>{/if}
      {#if started}<p class="download-help" role="status">Download started. Your browser will show its progress.</p>{/if}
      <footer><span>{count.toLocaleString()} {count === 1 ? 'photo' : 'photos'} · {bytes(totalBytes)}</span><button type="submit" class="primary-button" disabled={!count || started}><Icon name="download" size={18} />Download</button></footer>
    </form>
  {/if}
</dialog>

<style>
.download-dialog{position:fixed;inset:0;margin:auto;width:min(500px,calc(100% - 32px));max-height:calc(100dvh - 32px);overflow:auto;padding:24px;border:1px solid var(--border);border-radius:16px;color:var(--text);box-shadow:0 20px 80px #22183d33}.download-dialog::backdrop{background:#22142e70;backdrop-filter:blur(4px)}header,footer{display:flex;align-items:center;justify-content:space-between;gap:16px}h2{font-size:22px}header p,.download-help{font-size:12px;color:#797184;line-height:1.6;margin-top:7px}form{margin-top:20px;display:grid;gap:18px}fieldset{border:0;padding:0;min-width:0}legend{font-size:13px;font-weight:600}.contributor-actions{display:flex;justify-content:space-between;gap:10px;margin:10px 0}.text-button{font-size:12px}.download-contributors{display:grid;gap:3px;max-height:310px;overflow:auto;border:1px solid var(--border);border-radius:10px;padding:6px}.download-contributors label{display:flex;align-items:center;gap:10px;min-height:44px;padding:8px;font-size:13px;cursor:pointer}.download-contributors label>span{flex:1;min-width:0;overflow-wrap:anywhere}.download-contributors small{color:#797184;font-size:11px}.empty{opacity:.55}.download-updates{display:flex;align-items:center;gap:10px;min-height:44px;margin-top:15px;font-size:13px;cursor:pointer}input[type=checkbox]{width:18px;height:18px;margin:0;flex-shrink:0;accent-color:var(--accent)}footer{border-top:1px solid var(--border);padding-top:16px;font-size:12px;color:#797184}.error-text{font-size:13px} @media(max-width:650px){.download-dialog{padding:18px}}
</style>
