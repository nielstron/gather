<script lang="ts">
  import { createEventDispatcher, onDestroy } from 'svelte';
  import Icon from './Icon.svelte';
  import Thumbnail from './Thumbnail.svelte';
  import type { Photo, PhotoInformation, PhotoMetadata } from '$lib/types';
  export let photo: Photo;
  export let base: string;
  export let target: HTMLElement | undefined;
  function attach(node: HTMLElement) { target?.appendChild(node); return { destroy() { node.remove(); } }; }
  const dispatch = createEventDispatcher<{ close: void }>();
  let information: PhotoInformation | undefined;
  let loading = false;
  let controller: AbortController | undefined;
  let requested = '';
  let panel: HTMLElement;
  const cache = new Map<string, PhotoInformation>();
  $: key = `${photo.id}:${photo.revision || ''}`;
  $: if (key !== requested) { requested = key; void load(photo, key); }
  $: metadata = information?.metadata || {} as Partial<PhotoMetadata>;
  $: takenAt = metadata.takenAt || photo.takenAt;
  $: camera = [metadata.make, metadata.model?.startsWith(metadata.make || '\0') ? metadata.model?.slice(metadata.make!.length).trim() : metadata.model].filter(Boolean).join(' ');
  $: settings = [metadata.fNumber ? `ƒ/${metadata.fNumber}` : '', metadata.exposureTime ? `${metadata.exposureTime.replace(/\s*s$/, '')} s` : '', metadata.focalLength ? `${metadata.focalLength} mm` : '', metadata.iso ? `ISO ${metadata.iso}` : ''].filter(Boolean).join(' · ');
  $: width = metadata.width || photo.width;
  $: height = metadata.height || photo.height;
  $: location = [metadata.city, metadata.state, metadata.country].filter(Boolean).join(', ');
  $: coordinates = metadata.latitude !== undefined && metadata.longitude !== undefined;
  $: mapUrl = coordinates ? `https://www.openstreetmap.org/?mlat=${metadata.latitude}&mlon=${metadata.longitude}#map=14/${metadata.latitude}/${metadata.longitude}` : '';
  $: embedUrl = coordinates ? `https://www.openstreetmap.org/export/embed.html?bbox=${Math.max(-180, metadata.longitude! - .015)},${Math.max(-90, metadata.latitude! - .01)},${Math.min(180, metadata.longitude! + .015)},${Math.min(90, metadata.latitude! + .01)}&layer=mapnik&marker=${metadata.latitude},${metadata.longitude}` : '';
  function date(value: string) {
    // Immich's localDateTime is already the photographer's wall-clock time.
    const date = new Date(value.replace(/(?:Z|[+-]\d{2}:?\d{2})$/, '') + 'Z');
    return Number.isFinite(date.getTime()) ? date.toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short', timeZone: 'UTC' }) : value;
  }
  function bytes(value: number) { return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value / (value >= 1024 ** 2 ? 1024 ** 2 : 1024))} ${value >= 1024 ** 2 ? 'MB' : 'KB'}`; }
  async function load(current: Photo, requestKey: string, retry = false) {
    controller?.abort(); controller = new AbortController();
    information = retry ? undefined : cache.get(requestKey); loading = !information;
    panel?.scrollTo({ top: 0 });
    if (information) return;
    const signal = controller.signal;
    try {
      const response = await fetch(`${base}/api/photos/${current.id}/info`, { signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]) });
      const body = await response.json();
      if (signal.aborted || requested !== requestKey) return;
      if (!response.ok) throw new Error(body.error || 'Photo information is unavailable.');
      information = body;
      if (body.state === 'ready') { cache.set(requestKey, body); if (cache.size > 100) cache.delete(cache.keys().next().value!); }
    } catch { if (!signal.aborted && requested === requestKey) information = { state: 'unavailable' }; }
    finally { if (!signal.aborted && requested === requestKey) loading = false; }
  }
  onDestroy(() => controller?.abort());
</script>

<aside use:attach class="photo-info" aria-label="Photo information">
  <header><h2>Info</h2><button type="button" class="info-close" aria-label="Close photo information" on:click={() => dispatch('close')}><Icon name="close" size={24} /></button></header>
  <div class="info-content" bind:this={panel}>
    {#if metadata.description}<section class="info-description"><p>{metadata.description}</p></section>{/if}
    <section class="info-section"><h3>Details</h3>
      {#if takenAt}<div class="info-row"><Icon name="clock" /><div><strong>{date(takenAt)}</strong>{#if metadata.timeZone}<small>{metadata.timeZone}</small>{/if}</div></div>{/if}
      <div class="info-row"><Icon name="image" /><div><strong>{photo.name}</strong><small>{bytes(photo.bytes)}{#if width > 4 && height > 3} · {width} × {height} · {(width * height / 1_000_000).toFixed(1)} MP{/if}{#if metadata.mimeType}<br />{metadata.mimeType}{/if}</small></div></div>
      {#if camera || metadata.lensModel || settings}<div class="info-row"><Icon name="camera" /><div>{#if camera}<strong>{camera}</strong>{/if}{#if metadata.lensModel}<small>{metadata.lensModel}</small>{/if}{#if settings}<small>{settings}</small>{/if}</div></div>{/if}
      <div class="info-row"><Icon name="user" /><div><strong>{photo.owner}</strong><small>Shared by</small></div></div>
      <div class="info-row"><Icon name="folder" /><div><strong>{photo.folder || 'Shared folder'}/</strong><small>Collection folder</small></div></div>
      {#if metadata.rating}<div class="info-row"><Icon name="star" /><div><strong>{'★'.repeat(Math.min(5, Math.round(metadata.rating)))}</strong><small>Rating</small></div></div>{/if}
    </section>
    {#if metadata.people?.length}<section class="info-section"><h3>People</h3><div class="info-people">{#each metadata.people as person (person.id)}<div class="info-person"><span><Icon name="user" size={24} /><Thumbnail src={`${base}/api/search/people/${person.id}/thumbnail`} alt="" /></span>{person.name || 'Unnamed person'}</div>{/each}</div></section>{/if}
    {#if coordinates || location}<section class="info-section"><h3>Location</h3>{#if coordinates}<a class="info-map" href={mapUrl} target="_blank" rel="noopener noreferrer" aria-label="Open photo location in OpenStreetMap"><iframe tabindex="-1" title="Photo location" src={embedUrl} loading="lazy" referrerpolicy="no-referrer"></iframe><span class="info-map-open"><Icon name="external" size={18} /></span></a>{/if}{#if location}<p>{location}</p>{/if}{#if coordinates}<a class="info-map-link" href={mapUrl} target="_blank" rel="noopener noreferrer">{metadata.latitude!.toFixed(5)}, {metadata.longitude!.toFixed(5)} <Icon name="external" size={16} /></a>{/if}</section>{/if}
    {#if metadata.tags?.length}<section class="info-section"><h3>Tags</h3><div class="info-tags">{#each metadata.tags as tag}<span>{tag}</span>{/each}</div></section>{/if}
    {#if loading}<p class="info-status" role="status">Loading photo information…</p>{:else if information?.state !== 'ready'}<div class="info-status" role="status"><p>{information?.state === 'pending' ? 'Camera and location details will appear when indexing finishes.' : information?.state === 'unconfigured' ? 'Connect Immich to see camera and location details.' : 'Camera and location details are temporarily unavailable.'}</p><button type="button" on:click={() => load(photo, key, true)}><Icon name="refresh" size={16} />Retry</button></div>{/if}
  </div>
</aside>

<style>
  .photo-info{position:fixed;z-index:1600;right:0;top:0;width:360px;height:100dvh;background:#202124;color:#e8eaed;box-shadow:-4px 0 24px #0003;display:flex;flex-direction:column;font-size:14px;text-align:left}
  header{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid #ffffff18;flex-shrink:0}h2{font-size:20px;font-weight:500}.info-close{display:flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:50%;color:inherit}.info-close:hover{background:#ffffff14}.info-content{overflow:auto;overscroll-behavior:contain;padding-bottom:max(32px,env(safe-area-inset-bottom));flex:1;min-height:0}.info-section,.info-description{padding:22px 24px;border-bottom:1px solid #ffffff18}h3{font-size:14px;margin:0 0 20px;font-weight:600;color:#dfe1e5}.info-row{display:flex;align-items:flex-start;gap:18px;margin:0 0 23px}.info-row:last-child{margin-bottom:0}.info-row>:global(svg){color:#aeb4bd;margin-top:2px}.info-row>div{min-width:0}.info-row strong{display:block;font-weight:400;line-height:1.6;overflow-wrap:anywhere}small{display:block;font-size:12px;color:#aeb4bd;margin-top:3px;line-height:1.7;overflow-wrap:anywhere}p{line-height:1.7;overflow-wrap:anywhere;white-space:pre-line}.info-people{display:flex;flex-wrap:wrap;gap:16px}.info-person{display:flex;flex-direction:column;align-items:center;gap:8px;max-width:95px;font-size:12px;text-align:center;overflow-wrap:anywhere}.info-person>span{position:relative;display:flex;align-items:center;justify-content:center;width:56px;height:56px;border-radius:50%;overflow:hidden;background:#35373a}.info-person :global(svg){position:absolute;color:#aeb4bd}.info-person :global(img:not([src])){visibility:hidden}.info-person :global(img){position:relative;width:100%;height:100%;object-fit:cover}.info-map{position:relative;display:block}.info-map-open{position:absolute;top:8px;right:8px;display:flex;padding:6px;border-radius:6px;background:#202124dd;color:white}iframe{pointer-events:none;width:100%;height:170px;border:0;border-radius:10px;margin-bottom:14px;background:#35373a}.info-map-link{display:flex;align-items:center;gap:8px;color:#b7abff;font-size:12px;margin-top:10px}.info-tags{display:flex;flex-wrap:wrap;gap:8px}.info-tags>span{background:#ffffff14;border-radius:6px;padding:7px 10px;font-size:12px}.info-status{padding:20px 24px;color:#b9bec7;font-size:12px;line-height:1.7}.info-status button{display:flex;align-items:center;gap:6px;color:#c3b9ff;padding:12px 0}
  @media(max-width:760px){.photo-info{top:auto;bottom:0;width:100%;height:min(72dvh,660px);border-radius:16px 16px 0 0;box-shadow:0 -10px 35px #0007}.photo-info header{padding:8px 16px}.info-section,.info-description{padding:20px 24px}}
</style>
