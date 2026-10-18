<script context="module" lang="ts">
  import { createLimiter } from '$lib/async';
  // Leave HTTP/1.1 connections available for search, uploads, and other controls.
  const imageRequests = createLimiter(2);
</script>

<script lang="ts">
  import { cacheThumbnail, retainThumbnail, type ThumbnailLease } from '$lib/thumbnail-cache';
  import { onMount, createEventDispatcher } from 'svelte';
  export let src: string;
  export let alt: string;
  export let eager = false;
  export let imageStyle = '';
  const dispatch = createEventDispatcher<{ error: void }>();
  let element: HTMLImageElement;
  let objectUrl: string | undefined;
  let lease: ThumbnailLease | undefined;
  let visible = eager;
  let mounted = false;
  let requested = '';
  let controller: AbortController | undefined;
  let observer: IntersectionObserver | undefined;

  $: if (mounted && visible && requested !== src) {
    requested = src;
    controller?.abort();
    lease?.release(); lease = undefined; objectUrl = undefined;
    controller = new AbortController();
    const current = controller;
    const source = src;
    void imageRequests(async () => {
      if (current.signal.aborted) return;
      const cached = retainThumbnail(source);
      if (cached) { lease = cached; objectUrl = cached.url; return; }
      try {
        const response = await fetch(source, { signal: AbortSignal.any([current.signal, AbortSignal.timeout(15000)]) });
        if (!response.ok) throw new Error('Preview unavailable');
        const blob = await response.blob();
        if (current.signal.aborted || !mounted) return;
        lease?.release();
        lease = cacheThumbnail(source, blob);
        objectUrl = lease.url;
      } catch { if (!current.signal.aborted && mounted) dispatch('error'); }
    });
  }

  onMount(() => {
    mounted = true;
    observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { visible = true; observer?.disconnect(); }
    }, { rootMargin: '300px' });
    observer.observe(element);
    return () => {
      mounted = false;
      controller?.abort(); observer?.disconnect();
      lease?.release();
    };
  });
</script>

<img style={imageStyle} bind:this={element} src={objectUrl} {alt} decoding="async" on:error={() => { if (objectUrl) dispatch('error'); }} />
