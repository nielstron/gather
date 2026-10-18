<script context="module" lang="ts">
  import { createLimiter } from '$lib/async';
  // Leave HTTP/1.1 connections available for search, uploads, and other controls.
  const imageRequests = createLimiter(2);
</script>

<script lang="ts">
  import { onMount, createEventDispatcher } from 'svelte';
  export let src: string;
  export let alt: string;
  export let eager = false;
  const dispatch = createEventDispatcher<{ error: void }>();
  let element: HTMLImageElement;
  let objectUrl: string | undefined;
  let visible = eager;
  let mounted = false;
  let requested = '';
  let controller: AbortController | undefined;
  let observer: IntersectionObserver | undefined;

  $: if (mounted && visible && requested !== src) {
    requested = src;
    controller?.abort();
    if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = undefined; }
    controller = new AbortController();
    const current = controller;
    const source = src;
    void imageRequests(async () => {
      if (current.signal.aborted) return;
      try {
        const response = await fetch(source, { signal: AbortSignal.any([current.signal, AbortSignal.timeout(15000)]) });
        if (!response.ok) throw new Error('Preview unavailable');
        const blob = await response.blob();
        if (current.signal.aborted || !mounted) return;
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        objectUrl = URL.createObjectURL(blob);
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
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  });
</script>

<img bind:this={element} src={objectUrl} {alt} decoding="async" on:error={() => { if (objectUrl) dispatch('error'); }} />
