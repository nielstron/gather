<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte';
  import { modalHistory } from '$lib/modal-history';
  import type { ImportSummary } from '$lib/imports';
  import Icon from './Icon.svelte';
  export let base: string;
  export let name: string;
  export let collectionName: string;
  const dispatch = createEventDispatcher<{ changed: void; choose: void }>();
  let dialog: HTMLDialogElement;
  let view: 'choice' | 'import' = 'choice';
  let link = '', error = '', busy = false, selected = '';
  let jobs: ImportSummary[] = [];
  let timer: ReturnType<typeof setTimeout>;
  let disposed = false, polling = false;
  const controller = new AbortController();
  $: job = jobs.find(item => item.id === selected);
  $: active = jobs.find(item => ['queued', 'running'].includes(item.status));
  const labels = { ready: 'Ready to import', queued: 'Waiting to import', running: 'Importing', done: 'Import complete', partial: 'Some photos need another try', cancelled: 'Import cancelled', error: 'Import stopped' };

  function schedule() {
    clearTimeout(timer);
    if (!disposed && (jobs.some(job => ['queued', 'running'].includes(job.status)) || dialog?.open)) timer = setTimeout(() => void poll(), dialog?.open ? 1500 : 3000);
  }
  function update(next: ImportSummary[]) {
    if (next.some(job => job.imported > (jobs.find(old => old.id === job.id)?.imported ?? job.imported))) dispatch('changed');
    jobs = next;
    if (!selected) selected = next.find(job => ['queued', 'running'].includes(job.status))?.id || next[0]?.id || '';
  }
  async function poll() {
    if (disposed || polling) return;
    polling = true;
    try {
      const response = await fetch(`${base}/api/import`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Import progress could not be loaded.');
      if (!disposed) update(body.jobs);
    } catch (cause) { if (dialog?.open && !disposed) error = cause instanceof Error ? cause.message : 'Progress is temporarily unavailable. It will retry automatically.'; }
    finally { polling = false; schedule(); }
  }
  async function action(action: string) {
    if (busy) return;
    busy = true; error = '';
    try {
      const response = await fetch(`${base}/api/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action === 'preview' ? { action, url: link.trim() } : { action, id: selected }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(action === 'preview' ? 65_000 : 15_000)]) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'This import could not be updated.');
      if (disposed) return;
      selected = body.job.id;
      update([body.job, ...jobs.filter(job => job.id !== body.job.id)]);
      void poll();
    } catch (cause) { if (!disposed) error = cause instanceof Error && cause.name !== 'TimeoutError' ? cause.message : 'The request timed out. Try again; any started import continues on the server.'; }
    finally { busy = false; schedule(); }
  }
  export function open() { view = 'choice'; dialog.showModal(); error = ''; void poll(); }
  function chooseStorage() { dialog.close(); dispatch('choose'); }
  onMount(() => {
    void poll();
    return () => { disposed = true; controller.abort(); clearTimeout(timer); };
  });
</script>

<svelte:window on:online={() => void poll()} />
<div class="import-control">
  <button class="primary-button top-upload upload-trigger" on:click={open} aria-label="Upload photos" aria-haspopup="dialog"><Icon name="upload" size={18} /><span>Upload photos</span>{#if active}<span class="small-spinner" aria-label="Import in progress"></span>{/if}</button>
  <dialog use:modalHistory class="import-dialog" bind:this={dialog} on:close={schedule} aria-labelledby="import-heading">
    <header><div><h2 id="import-heading">{view === 'import' ? 'Import from link' : 'Upload photos'}</h2><p>{view === 'import' ? 'Bring a shared album into your collection.' : 'Choose how to add photos and videos.'}</p></div><button class="icon-button" on:click={() => dialog.close()} aria-label={view === 'import' ? 'Close import' : 'Close upload options'}><Icon name="close" /></button></header>
    {#if view === 'choice'}
      <div class="upload-choices">
        <button class="upload-choice" on:click={chooseStorage}><Icon name="folder" size={26} /><span><strong>Upload from storage</strong><small>Choose photos and videos from your device.</small></span><Icon name="chevron" size={18} /></button>
        <button class="upload-choice" on:click={() => view = 'import'}><Icon name="download" size={26} /><span><strong>Import from link</strong><small>{active ? `Importing ${active.processed} of ${active.total} photos` : 'Bring in a shared Google Photos album.'}</small></span><Icon name="chevron" size={18} /></button>
      </div>
      <details class="import-help"><summary>iPhone picker taking a long time after Add?</summary><p>Your iPhone prepares the entire selection before sending it to Gather. Large batches and iCloud photos can take a while without showing progress. Tap Add once and wait. If it stays stuck, cancel and try fewer items, or save the selection to Files in Photos and use Browse / Choose File.</p></details>
    {:else}
    <button class="text-button import-back" on:click={() => view = 'choice'}><Icon name="chevron" size={15} />Back to upload options</button>
    <form on:submit|preventDefault={() => action('preview')}>
      <label for="import-album-link">Shared album link</label>
      <div class="import-input"><input id="import-album-link" type="url" placeholder="https://photos.app.goo.gl/…" bind:value={link} required disabled={busy} /><button type="submit" class="primary-button" disabled={busy || !link.trim()}>{#if busy}<span class="small-spinner" aria-hidden="true"></span>{/if}Preview album</button></div>
      <p class="import-help">Supports public Google Photos albums.</p>
      <p class="import-help">Collection: <strong>{collectionName}</strong><br />Destination: <strong>My uploads · {name}</strong></p>
    </form>
    {#if error}<p class="import-error" role="alert">{error}</p>{/if}
    {#if job}
      <section class="import-job" aria-label="Album import" aria-live="polite">
        <div class="job-heading"><Icon name={job.status === 'done' ? 'check' : 'image'} /><div><h3>{job.title}</h3><p>{job.total.toLocaleString()} {job.total === 1 ? 'photo' : 'photos'}{#if job.unsupported} · {job.unsupported} {job.unsupported === 1 ? 'video excluded' : 'videos excluded'}{/if}</p></div></div>
        <strong class="job-status">{labels[job.status]}</strong>
        {#if job.status !== 'ready'}
          <progress max={job.total} value={job.processed} aria-label="Import progress"></progress>
          <p class="job-counts">{job.imported} imported · {job.duplicates} duplicates skipped{#if job.failed} · {job.failed} failed{/if}</p>
          {#each job.files as file}<p class:error={!!file.error} class="job-file">{file.name}{#if file.error} — {file.error}{/if}</p>{/each}
        {/if}
        {#if job.error}<p class="import-error">{job.error}</p>{/if}
        <div class="job-actions">
          {#if job.status === 'ready'}<button class="primary-button" disabled={busy || !!active} on:click={() => action('start')}><Icon name="download" size={18} />Import {job.total} {job.total === 1 ? 'photo' : 'photos'}</button>
          {:else if ['queued', 'running'].includes(job.status)}<button class="text-button" disabled={busy} on:click={() => action('cancel')}>Cancel import</button>
          {:else if ['partial', 'cancelled', 'error'].includes(job.status)}<button class="primary-button" disabled={busy || !!active} on:click={() => action('retry')}><Icon name="refresh" size={18} />Retry remaining photos</button>{/if}
        </div>
        <p class="import-help">Imports the downloadable copies supplied by Google. Existing files stay in place; identical photos are skipped.</p>
        {#if ['queued', 'running'].includes(job.status)}<p class="import-help">You can close this window. Importing continues on the server.</p>{/if}
      </section>
    {/if}
    {#if jobs.filter(item => item.id !== selected && item.status !== 'ready').length}
      <section class="recent-imports" aria-label="Recent imports"><h3>Recent imports</h3>{#each jobs.filter(item => item.id !== selected && item.status !== 'ready').slice(0, 5) as previous}<button on:click={() => selected = previous.id}><span>{previous.title}</span><small>{labels[previous.status]} · {previous.processed}/{previous.total}</small><Icon name="chevron" size={17} /></button>{/each}</section>
    {/if}
    {/if}
  </dialog>
</div>

<style>
  .upload-trigger{display:flex;align-items:center;gap:8px}.upload-choices{display:grid;gap:12px}.upload-choice{display:flex;align-items:center;gap:14px;padding:18px;border:1px solid var(--border);border-radius:12px;background:#faf9fd;text-align:left}.upload-choice>span{display:grid;gap:6px;flex:1}.upload-choice strong{font-size:14px}.upload-choice small{font-size:12px;color:#797184}.upload-choice:hover{border-color:var(--accent);background:#f3efff}.import-back{display:flex;align-items:center;gap:4px;font-size:12px;justify-self:start}.import-back :global(svg){transform:rotate(180deg)}
  .import-control{flex-shrink:0}.import-dialog{position:fixed;inset:0;margin:auto;width:min(600px,calc(100% - 32px));height:fit-content;max-height:calc(100dvh - 32px);overflow:auto;padding:24px;border:1px solid var(--border);border-radius:16px;color:var(--text,#393641);box-shadow:0 20px 80px #22183d33}.import-dialog[open]{display:grid;gap:22px}.import-dialog::backdrop{background:#22142e70;backdrop-filter:blur(4px)}header{display:flex;justify-content:space-between;gap:12px;align-items:start}h2{font-size:22px;line-height:1.3}header p,.import-help{overflow-wrap:anywhere;font-size:12px;color:#797184;line-height:1.6;margin-top:7px}form>label{display:block;font-size:13px;font-weight:550;margin-bottom:8px}.import-input{display:flex;gap:8px;align-items:stretch}.import-input input{flex:1;min-width:0;border:1px solid #ded8e9;border-radius:8px;padding:10px 12px;font-size:14px}.import-job{display:grid;gap:12px;background:#faf9fd;border:1px solid var(--border);padding:18px;border-radius:12px}.job-heading{display:flex;gap:10px;align-items:start}.job-heading :global(svg){color:var(--accent);margin-top:2px}h3{font-size:15px;line-height:1.4;overflow-wrap:anywhere}.job-heading p,.job-counts,.job-file{font-size:12px;color:#797184;line-height:1.5}.job-heading p{margin-top:4px}.job-status{font-size:13px;color:#61547d}progress{width:100%;height:8px;accent-color:var(--accent)}.job-file{overflow-wrap:anywhere}.import-error,.job-file.error{font-size:12px;line-height:1.6;color:#a0525e;overflow-wrap:anywhere}.job-actions{display:flex;align-items:center;gap:10px}.recent-imports{display:grid;gap:8px}.recent-imports button{display:flex;text-align:left;align-items:center;gap:8px;padding:10px;border:1px solid var(--border);border-radius:8px;font-size:12px}.recent-imports button>span{flex:1;overflow-wrap:anywhere}.recent-imports small{color:#797184;font-size:11px}@media(max-width:650px){.import-dialog{padding:18px}.import-input{flex-direction:column}.import-input input{font-size:16px}.recent-imports button{flex-wrap:wrap}.recent-imports small{flex-basis:100%}}
</style>
