<script lang="ts">
  import { base as appBase } from '$app/paths';
  import { page } from '$app/stores';
  import { collectionBase } from '$lib/collection-path';
  $: base = collectionBase($page.url.pathname, appBase);
  import { mdiDownload } from '@mdi/js';
  import { sortPhotos } from '$lib/sort';
  import { mapConcurrent } from '$lib/async';
  import { onMount } from 'svelte';
  import { Button, Badge } from '@immich/ui';
  import justifiedLayout from 'justified-layout';
  import PhotoSwipe from 'photoswipe';
  import { installProgressiveImages } from '$lib/progressive-viewer';
  import SortPicker from '$lib/components/SortPicker.svelte';
  import SearchFilters from '$lib/components/SearchFilters.svelte';
  import type { CollectionSearch } from '$lib/search';
  import Thumbnail from '$lib/components/Thumbnail.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import type { Member, Photo, PhotoList } from '$lib/types';

  export let data: { user: Member | null; members: Member[]; collectionName: string; maxUploadBytes: number; immichConfigured: boolean };
  type Upload = { id: string; file: File; progress: number; status: 'waiting' | 'checking' | 'uploading' | 'retrying' | 'done' | 'error' | 'cancelled'; attempts?: number; duplicate?: boolean; error?: string; xhr?: XMLHttpRequest; checksum?: string; controller?: AbortController };
  let photos: Photo[] = [];
  let folders: PhotoList['folders'] = [];
  let total = 0;
  let hasMore = false;
  let loading = true;
  let error = '';
  let folder = '';
  let query = '';
  let searchOptions: CollectionSearch = { mode: 'semantic' };
  let searchTruncated = false;
  let searchOrder = false;
  let searchFilters: SearchFilters;
  let sort = 'relevance';
  let sortDirection = 'desc';
  let selected = new Set<string>();
  let imageErrors = new Set<string>();
  let galleryWidth = 900;
  let token = '';
  let shareToken = '';
  let sharedLink = '';
  let joinName = '';
  let authError = '';
  let signingIn = false;
  let profileName = '';
  let profileError = '';
  let savingProfile = false;
  let profileDialog: HTMLDialogElement;
  let previewService = data.immichConfigured ? 'ready' : 'unconfigured';
  let input: HTMLInputElement;
  let uploads: Upload[] = [];
  let uploadPanelOpen = true;
  let uploadPanelHeight = 0;
  let uploading = false;
  let disposed = false;
  const checkingContent = new Map<string, Promise<void>>();
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let dragging = false;
  let dragTimer: ReturnType<typeof setTimeout>;
  let searchTimer: ReturnType<typeof setTimeout>;
  let fetchNumber = 0;
  let galleryRequest: AbortController | undefined;
  let pendingPhoto: Photo | null = null;
  let pendingDialog: HTMLDialogElement;
  let viewer: PhotoSwipe | undefined;
  let fastPollingUntil = 0;
  let nextPreviewPoll = 0;

  $: currentOwner = data.members.find((member) => member.folder === folder);
  $: pageTitle = !folder ? 'All photos' : folder === data.user?.folder ? 'My uploads' : `${currentOwner?.name || folder}’s photos`;
  $: collectionLabel = !folder ? 'All photos' : `${currentOwner?.name || folder}${currentOwner?.id === data.user?.id ? ' (you)' : ''}`;
  $: allSelected = photos.length > 0 && photos.slice(0, 200).every((photo) => selected.has(photo.id));
  $: selectionAction = allSelected ? 'Deselect all' : photos.length > 200 ? 'Select first 200' : 'Select all';
  $: hasSearch = !!query.trim() || !!Object.keys(searchOptions.filter || {}).length || !!searchOptions.queryAssetId;
  $: semanticQuery = searchOptions.mode === 'semantic' && !!(query.trim() || searchOptions.queryAssetId);
  $: sortChoice = `${sort === 'relevance' && !semanticQuery && !searchOptions.orderBy ? 'newest' : sort}:${sortDirection}`;
  $: sortLabel = sortChoice.startsWith('name:') ? `Filename · ${sortDirection === 'asc' ? 'A–Z (ascending)' : 'Z–A (descending)'}` : sortChoice.startsWith('relevance:') ? `${searchOptions.orderBy ? 'Search order' : 'Relevance'} · ${sortDirection === 'asc' ? 'Ascending' : 'Descending'}` : `Date added · ${sortDirection === 'asc' ? 'Oldest first (ascending)' : 'Newest first (descending)'}`;
  $: sortedPhotos = searchOrder ? photos : sortPhotos(photos, sort, sortDirection);
  $: photoIndexes = new Map(sortedPhotos.map((photo, index) => [photo.id, index]));
  $: timelineGroups = groupTimeline(sortedPhotos, galleryWidth, searchOrder ? 'name' : sort);
  $: completedUploads = uploads.filter((upload) => upload.status === 'done').length;
  $: activeUploads = uploads.filter((upload) => upload.status === 'waiting' || upload.status === 'checking' || upload.status === 'uploading' || upload.status === 'retrying').length;
  $: totalFolderPhotos = folders.reduce((sum, entry) => sum + entry.count, 0);

  function dayLabel(date: Date) {
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    if (date.toDateString() === today.toDateString()) return 'Today';
    if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
    const weekStart = new Date(today);
    weekStart.setDate(today.getDate() - 6);
    weekStart.setHours(0, 0, 0, 0);
    if (date >= weekStart && date < today) return date.toLocaleDateString(undefined, { weekday: 'long' });
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(date.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) });
  }

  function groupTimeline(items: Photo[], width: number, order: string) {
    const groups = new Map<string, { key: string; label: string; photos: Photo[] }>();
    for (const photo of items) {
      const date = new Date(photo.modifiedAt);
      const key = order === 'name' ? 'all' : `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
      if (!groups.has(key)) groups.set(key, { key, label: order === 'name' ? '' : dayLabel(date), photos: [] });
      groups.get(key)!.photos.push(photo);
    }
    return [...groups.values()].map((group) => ({ ...group, layout: justifiedLayout(
      group.photos.map((photo) => ({ width: photo.width || 4, height: photo.height || 3 })),
      { containerWidth: Math.max(width, 1), targetRowHeight: width < 600 ? 100 : 235,
        targetRowHeightTolerance: 0.25, containerPadding: 0, boxSpacing: 2 }
    ) }));
  }

  function mediaUrl(photo: Photo, kind: 'thumbnail' | 'preview' | 'fullsize' | 'original') {
    return `${base}/api/media/${photo.id}?kind=${kind}&v=${encodeURIComponent(photo.revision || photo.modifiedAt)}`;
  }

  function bytes(value: number) {
    if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }

  async function loadPhotos(append = false) {
    const request = ++fetchNumber;
    const requestedFolder = folder;
    const requestedQuery = query.trim();
    const requestedSort = sort === 'relevance' ? ((searchOptions.mode === 'semantic' && !!(requestedQuery || searchOptions.queryAssetId)) || searchOptions.orderBy ? 'relevance' : 'date') : sort;
    const effectiveOptions = { ...searchOptions };
    if (sort !== 'relevance') delete effectiveOptions.orderBy;
    else if (effectiveOptions.orderBy) effectiveOptions.orderBy = { ...effectiveOptions.orderBy, direction: sortDirection as 'asc' | 'desc' };
    const requestedOptions = JSON.stringify(effectiveOptions);
    const requestedDirection = sortDirection;
    const existingPhotos = photos;
    const targetCount = append ? 150 : Math.max(150, existingPhotos.length);
    const baseOffset = append ? existingPhotos.length : 0;
    loading = true;
    error = '';
    galleryRequest?.abort();
    const controller = new AbortController();
    galleryRequest = controller;
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const offsets = Array.from({ length: Math.ceil(targetCount / 300) }, (_, index) => index * 300);
      const pages = await mapConcurrent(offsets, 4, async offset => {
        const params = new URLSearchParams({ q: requestedQuery, offset: String(baseOffset + offset), limit: String(Math.min(300, targetCount - offset)), sort: requestedSort === 'relevance' ? 'relevance' : requestedSort === 'name' ? 'name' : 'date', direction: requestedDirection, search: requestedOptions });
        if (requestedFolder) params.set('folder', requestedFolder);
        // Large ID/condition lists exceed common proxy URL limits; keep them in a bounded body.
        const response = params.toString().length > 6000
          ? await fetch(`${base}/api/photos`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(params)), signal: controller.signal })
          : await fetch(`${base}/api/photos?${params}`, { signal: controller.signal });
        const body = await response.json();
        if (response.status === 401) { location.reload(); throw new Error('Your session has expired.'); }
        if (!response.ok) throw new Error(body.error || 'Your photos could not be loaded. Please try again.');
        return body as PhotoList;
      });
      if (request !== fetchNumber) return;
      const refreshedPhotos = pages.flatMap(page => page.photos);
      const result = pages[pages.length - 1];
      photos = append ? [...existingPhotos, ...refreshedPhotos] : refreshedPhotos;
      data = { ...data, members: result.members };
      folders = result.folders;
      total = result.total;
      hasMore = result.hasMore;
      searchTruncated = !!result.searchTruncated;
      searchOrder = requestedSort === 'relevance';
      previewService = result.previewService;
      imageErrors = new Set();
    } catch (cause) {
      if (request === fetchNumber) error = controller.signal.aborted
        ? 'Loading is taking longer than expected. Please try again.'
        : cause instanceof Error ? cause.message : 'Unable to load your photos.';
    } finally {
      clearTimeout(timeout);
      if (galleryRequest === controller) galleryRequest = undefined;
      if (request === fetchNumber) loading = false;
    }
  }

  function changeSort() {
    selected = new Set();
    photos = [];
    void loadPhotos();
  }

  function navigate(next: string) {
    folder = next;
    selected = new Set();
    photos = [];
    void loadPhotos();
  }

  function search() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { selected = new Set(); void loadPhotos(); }, 300);
  }

  async function signIn() {
    if (!token.trim() || signingIn) return;
    signingIn = true;
    authError = '';
    let invite = token.trim();
    try {
      if (/^https?:\/\//i.test(invite)) {
        const url = new URL(invite);
        if (url.origin === location.origin && collectionBase(url.pathname, appBase) !== base) { location.assign(url.toString()); return; }
        invite = new URLSearchParams(url.hash.slice(1)).get('invite') || '';
      }
      const response = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: invite }) });
      token = '';
      if (!response.ok) { const body = await response.json(); throw new Error(body.error || 'This invite is not valid. Ask your host for a new link.'); }
      location.reload();
    } catch (cause) {
      authError = cause instanceof Error ? cause.message : 'Unable to sign in. Please try again.';
      signingIn = false;
    }
  }

  function acceptSharedLink() {
    authError = '';
    try {
      const link = new URL(sharedLink.trim(), location.href);
      const shared = new URLSearchParams(link.hash.slice(1)).get('share');
      if (!shared) throw new Error('This link does not include an invitation. Ask your host for the collection’s shared link.');
      if (link.origin === location.origin && collectionBase(link.pathname, appBase) !== base) { location.assign(link.toString()); return; }
      shareToken = shared;
      sharedLink = '';
      history.replaceState(null, '', `${location.pathname}${location.search}#share=${encodeURIComponent(shared)}`);
    } catch (cause) {
      authError = cause instanceof Error ? cause.message : 'Please paste the complete shared link from your host.';
    }
  }

  async function joinCollection() {
    if (!shareToken || !joinName.trim() || signingIn) return;
    signingIn = true;
    authError = '';
    try {
      const response = await fetch(`${base}/api/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: shareToken, name: joinName.trim() }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Unable to join. Ask your host for a fresh shared link.');
      history.replaceState(null, '', `${location.pathname}${location.search}`);
      shareToken = '';
      location.reload();
    } catch (cause) {
      authError = cause instanceof Error ? cause.message : 'Unable to join. Please try again.';
      signingIn = false;
    }
  }

  function openProfile() {
    profileName = data.user?.name || '';
    profileError = '';
    profileDialog.showModal();
  }

  async function saveProfile() {
    if (!profileName.trim() || savingProfile) return;
    savingProfile = true;
    profileError = '';
    try {
      const response = await fetch(`${base}/api/profile`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: profileName.trim() }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Your name could not be saved. Please try again.');
      const user = body.user as Member;
      data = { ...data, user, members: data.members.map((member) => member.id === user.id ? user : member) };
      profileDialog.close();
      await loadPhotos();
    } catch (cause) {
      profileError = cause instanceof Error ? cause.message : 'Your name could not be saved.';
    } finally { savingProfile = false; }
  }

  async function signOut() {
    try {
      const response = await fetch(`${base}/api/logout`, { method: 'POST' });
      if (!response.ok) throw new Error('Could not sign out. Please try again.');
      location.reload();
    } catch (cause) { error = cause instanceof Error ? cause.message : 'Could not sign out.'; }
  }

  function toggleSelect(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else if (next.size < 200) next.add(id);
    else { error = 'You can download up to 200 photos at a time. Download this selection, then choose the next photos.'; return; }
    selected = next;
  }

  function openPhoto(photo: Photo) {
    if (selected.size) { toggleSelect(photo.id); return; }
    if (photo.previewStatus !== 'ready' || imageErrors.has(photo.id)) {
      pendingPhoto = photo;
      pendingDialog.showModal();
      return;
    }
    const viewable = sortedPhotos.filter((item) => item.previewStatus === 'ready' && !imageErrors.has(item.id));
    viewer = new PhotoSwipe({
      dataSource: viewable.map((item) => ({ src: mediaUrl(item, 'preview'), msrc: mediaUrl(item, 'thumbnail'), thumbnailSrc: mediaUrl(item, 'thumbnail'), fullSrc: mediaUrl(item, 'fullsize'), width: item.width || 1600, height: item.height || 1200, alt: item.name })),
      index: viewable.findIndex((item) => item.id === photo.id), bgOpacity: 0.97,
      preload: [1, 1], showHideAnimationType: 'fade', errorMsg: 'Immich has not finished this preview. You can still download the original.',
    });
    const activeViewer = viewer;
    installProgressiveImages(activeViewer);
    activeViewer.on('destroy', () => { if (viewer === activeViewer) viewer = undefined; });
    activeViewer.on('uiRegister', () => {
      activeViewer.ui?.registerElement({
        name: 'download-original', order: 11, isButton: true, tagName: 'a', title: 'Download original',
        html: { isCustomSVG: true, size: 24, inner: `<path d="${mdiDownload}"/>` },
        onInit: (element) => {
          const update = () => { const current = viewable[activeViewer.currIndex]; if (current) { (element as HTMLAnchorElement).href = mediaUrl(current, 'original'); element.setAttribute('download', current.name); element.setAttribute('aria-label', `Download ${current.name}`); } };
          activeViewer.on('change', update); update();
        },
      });
      activeViewer.ui?.registerElement({ name: 'photo-caption', order: 9, isButton: false, appendTo: 'root', onInit: (element) => {
        const update = () => { const current = viewable[activeViewer.currIndex]; element.textContent = current ? `${current.name} · ${current.owner}` : ''; };
        activeViewer.on('change', update); update();
      } });
    });
    activeViewer.init();
  }

  function addUploads(files: FileList | File[]) {
    if (!data.user) return;
    const items: Upload[] = Array.from(files).map((file) => ({ id: crypto.randomUUID(), file, progress: 0, status: file.size > data.maxUploadBytes ? 'error' : 'waiting', error: file.size > data.maxUploadBytes ? `This file exceeds the ${bytes(data.maxUploadBytes)} limit.` : undefined }));
    uploads = [...uploads, ...items];
    uploadPanelOpen = true;
    void processUploads();
  }

  function updateUpload(id: string, patch: Partial<Upload>) { uploads = uploads.map((item) => item.id === id ? { ...item, ...patch } : item); }

  function scheduleRetry(id: string, message: string, retryAfter = 0) {
    const item = uploads.find(entry => entry.id === id);
    if (!item || disposed || item.status === 'cancelled') return;
    const attempts = item.attempts || 0;
    if (attempts >= 6) {
      updateUpload(id, { status: 'error', error: `${message} Automatic retries exhausted. Please retry.`, xhr: undefined });
      return;
    }
    const delay = Math.max(Math.min(retryAfter, 60_000), Math.min(1000 * 2 ** Math.max(0, attempts - 1), 16_000));
    updateUpload(id, { status: 'retrying', progress: 0, xhr: undefined, error: navigator.onLine ? `${message} Retrying automatically…` : 'Waiting for connection…' });
    clearTimeout(retryTimers.get(id));
    retryTimers.set(id, setTimeout(() => {
      retryTimers.delete(id);
      if (disposed || uploads.find(entry => entry.id === id)?.status !== 'retrying') return;
      if (!navigator.onLine) { updateUpload(id, { error: 'Waiting for connection…' }); return; }
      updateUpload(id, { status: 'waiting', error: undefined });
      void processUploads();
    }, delay));
  }

  function resumeUploads() {
    if (!data.user || disposed) return;
    for (const item of uploads.filter(entry => entry.status === 'retrying')) {
      clearTimeout(retryTimers.get(item.id)); retryTimers.delete(item.id);
      updateUpload(item.id, { status: 'waiting', error: undefined });
    }
    void processUploads();
  }

  async function processUploads() {
    if (uploading || disposed || !data.user || !uploads.some(item => item.status === 'waiting')) return;
    uploading = true;
    const completedBefore = uploads.filter((entry) => entry.status === 'done').length;
    await Promise.all(Array.from({ length: 2 }, async () => {
      while (!disposed && uploads.some((item) => item.status === 'waiting')) {
        const item = uploads.find((entry) => entry.status === 'waiting')!;
        if (!navigator.onLine) { scheduleRetry(item.id, 'Waiting for connection…'); continue; }
        const controller = new AbortController();
        updateUpload(item.id, { status: 'checking', attempts: (item.attempts || 0) + 1, controller, error: undefined, progress: 0 });
        let releaseContent: (() => void) | undefined;
        let contentKey: string | undefined;
        let reservation: Promise<void> | undefined;
        try {
          // Web Crypto hashes locally; only this digest and size are sent during preflight.
          const checksum = item.checksum || Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await item.file.arrayBuffer())), byte => byte.toString(16).padStart(2, '0')).join('');
          updateUpload(item.id, { checksum });
          contentKey = `${checksum}:${item.file.size}`;
          // Same-content queue entries wait for the current attempt, then check again.
          // Different photos continue independently on both upload workers.
          while (checkingContent.has(contentKey)) {
            await checkingContent.get(contentKey);
            controller.signal.throwIfAborted();
            if (disposed) return;
          }
          controller.signal.throwIfAborted();
          if (disposed) return;
          reservation = new Promise<void>(resolve => { releaseContent = resolve; });
          checkingContent.set(contentKey, reservation);
          const response = await fetch(`${base}/api/upload/check`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ checksum, size: item.file.size }),
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(65_000)])
          });
          const result = await response.json();
          controller.signal.throwIfAborted();
          if (disposed) return;
          if (!response.ok) {
            if ([408, 425, 429].includes(response.status) || response.status >= 500) scheduleRetry(item.id, result.error || 'Duplicate check temporarily unavailable.');
            else updateUpload(item.id, { status: 'error', error: result.error || 'Duplicate check failed.' });
            continue;
          }
          if (typeof result.duplicate !== 'boolean') throw new Error('Invalid duplicate check response');
          if (result.duplicate) {
            updateUpload(item.id, { status: 'done', duplicate: true, progress: 100 });
            continue;
          }
          await new Promise<void>((resolve) => {
            const xhr = new XMLHttpRequest();
            updateUpload(item.id, { status: 'uploading', xhr });
            xhr.open('POST', `${base}/api/upload`);
            xhr.setRequestHeader('X-Filename', encodeURIComponent(item.file.name));
            xhr.setRequestHeader('X-Upload-Id', item.id);
            xhr.setRequestHeader('X-Upload-Size', String(item.file.size));
            xhr.setRequestHeader('Content-Type', item.file.type || 'application/octet-stream');
            // Detect a stalled connection without timing out a file that is still transferring.
            let watchdog: ReturnType<typeof setTimeout>;
            let stalled = false;
            const touch = () => { clearTimeout(watchdog); watchdog = setTimeout(() => { stalled = true; xhr.abort(); }, 90_000); };
            const finish = () => { clearTimeout(watchdog); resolve(); };
            xhr.upload.onprogress = (event) => { touch(); if (event.lengthComputable) updateUpload(item.id, { progress: Math.round(event.loaded / event.total * 100) }); };
            xhr.onprogress = touch;
            xhr.onload = () => {
              let body: { error?: string; photo?: { duplicate?: boolean } } = {};
              try { body = JSON.parse(xhr.responseText); } catch { /* Give a useful error for proxy responses. */ }
              if (xhr.status >= 200 && xhr.status < 300) updateUpload(item.id, { status: 'done', duplicate: !!body.photo?.duplicate, progress: 100, xhr: undefined });
              else if ([408, 425, 429].includes(xhr.status) || xhr.status >= 500) {
                const header = xhr.getResponseHeader('Retry-After');
                const retryAfter = header ? (/^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now()) : 0;
                scheduleRetry(item.id, body.error || 'Upload temporarily unavailable.', Number.isFinite(retryAfter) ? Math.max(0, retryAfter) : 0);
              } else updateUpload(item.id, { status: 'error', error: body.error || `Upload failed (${xhr.status}). Please retry.`, xhr: undefined });
              finish();
            };
            xhr.onerror = () => { scheduleRetry(item.id, 'Connection interrupted.'); finish(); };
            xhr.onabort = () => {
              if (stalled) scheduleRetry(item.id, 'Connection timed out.');
              else updateUpload(item.id, { status: 'cancelled', xhr: undefined });
              finish();
            };
            touch(); xhr.send(item.file);
          });
        } catch {
          if (!controller.signal.aborted && !disposed) scheduleRetry(item.id, 'Duplicate check interrupted.');
        } finally {
          if (contentKey && checkingContent.get(contentKey) === reservation) checkingContent.delete(contentKey);
          releaseContent?.();
          updateUpload(item.id, { controller: undefined });
        }
      }
    }));
    uploading = false;
    if (uploads.filter((entry) => entry.status === 'done').length > completedBefore) {
      fastPollingUntil = Date.now() + 120_000;
      nextPreviewPoll = 0;
      if (!disposed) await loadPhotos();
    }
  }

  function retryUpload(item: Upload) { if (item.file.size > data.maxUploadBytes) return; updateUpload(item.id, { status: 'waiting', attempts: 0, error: undefined }); void processUploads(); }
  function cancelUpload(item: Upload) {
    clearTimeout(retryTimers.get(item.id)); retryTimers.delete(item.id);
    item.controller?.abort();
    if (item.xhr) item.xhr.abort(); else updateUpload(item.id, { status: 'cancelled' });
  }
  function handleDrag(event: DragEvent) {
    if (!data.user || !event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault(); dragging = true;
    clearTimeout(dragTimer); dragTimer = setTimeout(() => { dragging = false; }, 200);
  }
  function handleDrop(event: DragEvent) { event.preventDefault(); dragging = false; if (event.dataTransfer?.files) addUploads(event.dataTransfer.files); }

  onMount(() => {
    const fragment = new URLSearchParams(location.hash.slice(1));
    const invite = fragment.get('invite');
    const shared = fragment.get('share');
    if (invite) { history.replaceState(null, '', `${location.pathname}${location.search}`); token = invite; void signIn(); }
    else if (data.user) {
      if (shared) history.replaceState(null, '', `${location.pathname}${location.search}`);
      void loadPhotos();
    } else if (shared) shareToken = shared;
    fastPollingUntil = Date.now() + 120_000;
    const interval = setInterval(() => {
      const now = Date.now();
      if (data.user && previewService !== 'unconfigured' && now >= nextPreviewPoll && !loading && !uploading && !document.hidden && (imageErrors.size > 0 || photos.some((photo) => photo.previewStatus !== 'ready'))) {
        nextPreviewPoll = now + (previewService === 'ready' && now < fastPollingUntil ? 7_000 : 30_000);
        void loadPhotos();
      }
    }, 7_000);
    return () => { disposed = true; galleryRequest?.abort(); for (const timer of retryTimers.values()) clearTimeout(timer); retryTimers.clear(); clearInterval(interval); clearTimeout(searchTimer); clearTimeout(dragTimer); viewer?.destroy(); uploads.forEach((item) => { item.controller?.abort(); item.xhr?.abort(); }); };
  });
</script>

<svelte:head><title>{data.collectionName} · Gather</title><meta name="description" content="A shared place for everyone's photos. Upload to your own folder and download the moments you love." /></svelte:head>
<svelte:window on:online={resumeUploads} on:dragover={handleDrag} on:drop={handleDrop} />

{#if !data.user}
  <main class="welcome">
    <a href={`${base}/`} class="brand welcome-brand" aria-label="Gather home"><span class="brand-mark"><Icon name="grid" size={21} /></span>gather<span class="brand-period">.</span></a>
    <div class="welcome-content">
      <div class="welcome-art" aria-hidden="true">
        <div class="art-orbit orbit-one"></div><div class="art-orbit orbit-two"></div>
        <div class="art-photo photo-back"><div class="art-sun"></div><div class="art-hill hill-back"></div><div class="art-hill"></div></div>
        <div class="art-photo photo-front"><div class="art-sun"></div><div class="art-hill hill-back"></div><div class="art-hill"></div></div>
        <div class="art-folder"><Icon name="folder" size={38} /><span>Good times, together.</span></div>
        <span class="art-spark"><Icon name="spark" size={27} /></span>
      </div>
      <div class="welcome-eyebrow"><span class="status-dot"></span> YOUR PEOPLE. YOUR PHOTOS.</div>
      <h1>Every perspective.<br /><span>One shared place.</span></h1>
      <p class="welcome-description">The moments you captured, and the ones you missed.<br class="desktop-break" /> Bring everyone’s photos together in {data.collectionName}.</p>
      {#if shareToken}
      <form class="invite-form" on:submit|preventDefault={joinCollection}>
        <label for="join-name">Your name</label>
        <div class="invite-input"><Icon name="people" size={18} /><input id="join-name" type="text" bind:value={joinName} autocomplete="given-name" placeholder="What should we call you?" maxlength="80" required disabled={signingIn} /></div>
        {#if authError}<p class="form-error" role="alert">{authError}</p>{/if}
        <Button type="submit" class="primary-button enter-button" loading={signingIn} disabled={!joinName.trim() || signingIn}>Join collection <Icon name="arrow" size={18} /></Button>
        <p class="invite-hint">We’ll make a folder for you. You can change your name anytime.</p>
        <p class="identity-hint">This browser remembers you. People with the same name get separate upload folders.</p>
      </form>
      {:else}
      <form class="invite-form" on:submit|preventDefault={acceptSharedLink}>
        <label for="shared-link">Shared collection link</label>
        <div class="invite-input"><Icon name="lock" size={18} /><input id="shared-link" type="url" bind:value={sharedLink} autocomplete="off" placeholder="Paste the shared link from your host" required disabled={signingIn} /></div>
        {#if authError}<p class="form-error" role="alert">{authError}</p>{/if}
        <Button type="submit" class="primary-button enter-button" loading={signingIn} disabled={!sharedLink.trim() || signingIn}>Continue <Icon name="arrow" size={18} /></Button>
        <p class="invite-hint">One link for everyone. Ask your host to share it with you.</p>
      </form>
      {/if}
    </div>
    <footer class="welcome-footer"><Icon name="folder" size={15} /> Your originals, on your own server. <a href={`${base}/admin`}>Manage collection</a></footer>
  </main>
{:else}
  <div class="app-shell">
    <aside class="sidebar">
      <button class="identity-button" on:click={openProfile} aria-label={`Change name for ${data.user.name}`} aria-haspopup="dialog" title={`Change name: ${data.user.name}`}><span class="identity-icon"><Icon name="user" size={22} /></span><span class="identity-name">{data.user.name}</span></button>
      <div class="space-label"><span class="space-icon"><Icon name="folder" size={18} /></span><div><strong>{data.collectionName}</strong><span>Shared collection</span></div><Icon name="chevron" size={15} /></div>
      <nav aria-label="Photo library">
        <p class="nav-label">LIBRARY</p>
        <button class:active={!folder} class="nav-item" on:click={() => navigate('')}><Icon name="image" /><span>All photos</span><span class="nav-count">{totalFolderPhotos || ''}</span></button>
        <button class:active={folder === data.user.folder} class="nav-item" on:click={() => navigate(data.user!.folder)}><Icon name="upload" /><span>My uploads</span></button>
        <div class="contributors-heading"><p class="nav-label">CONTRIBUTORS</p><span>{data.members.length}</span></div>
        {#each data.members as member, index}
          <button class:active={folder === member.folder} class="nav-item person-nav" on:click={() => navigate(member.folder)}>
            <span class="person-avatar tone-{index % 5}">{member.name.slice(0, 1).toUpperCase()}</span><span>{member.name}{member.id === data.user.id ? ' (you)' : ''}</span><span class="nav-count">{folders.find((entry) => entry.folder === member.folder)?.count || ''}</span>
          </button>
        {/each}
      </nav>
      <div class="sidebar-bottom">
        <div class="sharing-note"><span class="sharing-note-icon"><Icon name="people" size={18} /></span><strong>Better together</strong><p>Everyone in this collection can see and download all originals.</p></div>
      </div>
    </aside>
    <main class="main-content">
      <header class="topbar">
        <button class="identity-button mobile-identity" on:click={openProfile} aria-label={`Change name for ${data.user.name}`} aria-haspopup="dialog" title={`Change name: ${data.user.name}`}><span class="identity-icon"><Icon name="user" size={22} /></span><span class="identity-name">{data.user.name}</span></button>
        <div class="breadcrumb"><Icon name="folder" size={16} /><span>{data.collectionName}</span><Icon name="chevron" size={13} /><strong>{pageTitle}</strong></div>
        <label class="search-input"><Icon name="search" size={18} /><input type="search" aria-label="Search photos" placeholder="Describe a scene, place, or moment…" bind:value={query} on:input={search} /><span class="search-hint">{searchOptions.mode === 'semantic' ? 'by meaning' : searchOptions.mode === 'filename' ? 'by filename' : 'descriptions'}</span></label>
        <Button class="primary-button top-upload" onclick={() => input.click()}><Icon name="upload" size={17} /><span>Upload photos</span></Button>
      </header>
      <section class="gallery-section" aria-label="Photo collection" style:padding-bottom={uploads.length ? `${uploadPanelHeight + 48}px` : undefined}>
        <h1 class="sr-only">{pageTitle}</h1>
        <div class="gallery-toolbar">
          <div class="collection-controls">
            <div class="collection-picker">
              <label class="sr-only" for="folder-filter">Choose collection</label>
              <span class="collection-name" aria-hidden="true">{collectionLabel}</span>
              <span id="photo-count" class="photo-count" title={`${total.toLocaleString()} ${total === 1 ? 'photo' : 'photos'}${query ? ` matching “${query}”` : ''}`}>{total.toLocaleString()}<span class="sr-only"> {total === 1 ? 'photo' : 'photos'}{query ? ` matching “${query}”` : ''}</span></span>
              <span class="collection-chevron"><Icon name="chevron" size={15} /></span>
              <select id="folder-filter" value={folder} aria-describedby="photo-count" on:change={(event) => navigate(event.currentTarget.value)}><option value="">All photos</option>{#each data.members as member}<option value={member.folder}>{member.name}{member.id === data.user.id ? ' (you)' : ''}</option>{/each}</select>
            </div>
            <div class="collection-actions">
              {#if photos.length}<button class="icon-button select-all" class:active={allSelected} on:click={() => { selected = allSelected ? new Set() : new Set(photos.slice(0, 200).map((photo) => photo.id)); }} aria-label={selectionAction} title={selectionAction} aria-pressed={allSelected}><Icon name="select-all" size={20} /></button>{/if}
              <SortPicker field={sortChoice.split(':')[0]} direction={sortDirection} label={sortLabel} relevanceLabel={searchOptions.orderBy ? 'Search order' : semanticQuery ? 'Relevance' : ''} on:change={(event) => { sort = event.detail.field; sortDirection = event.detail.direction; changeSort(); }} />
              <button class="icon-button" on:click={() => loadPhotos()} disabled={loading} aria-label="Refresh photos" title="Refresh photos">{#if loading}<span class="small-spinner" aria-hidden="true"></span>{:else}<Icon name="refresh" size={18} />{/if}</button>
            </div>
          </div>
        </div>
        <SearchFilters {query} bind:this={searchFilters} bind:value={searchOptions} on:apply={(event) => { searchOptions = event.detail; selected = new Set(); photos = []; sort = 'relevance'; sortDirection = searchOptions.orderBy?.direction || 'desc'; void loadPhotos(); }} />
        {#if searchTruncated}<p class="search-limit-notice">Showing the best {total} semantic matches. Add filters to narrow the results.</p>{/if}
        {#if previewService !== 'ready'}<div class="service-notice"><Icon name="info" size={19} /><div><strong>{previewService === 'unconfigured' ? 'Connect Immich to bring your gallery to life' : 'Immich previews are temporarily unavailable'}</strong><p>{previewService === 'unconfigured' ? 'Your host needs to connect an Immich external library. You can already upload photos and download originals.' : 'Your photos are safely stored. You can keep uploading and downloading originals while Immich reconnects.'}</p></div><button class="text-button" on:click={() => loadPhotos()}>Refresh</button></div>{/if}
        {#if error}<div class="error-notice" role="alert"><Icon name="info" size={18} /><span>{error}</span><button class="text-button" on:click={() => loadPhotos()}>Try again</button></div>{/if}
        {#if selected.size}<div class="selection-bar"><button class="icon-button" on:click={() => { selected = new Set(); }} aria-label="Clear selection"><Icon name="close" size={18} /></button><strong>{selected.size} selected</strong><form method="POST" action={`${base}/api/download`}><input type="hidden" name="ids" value={JSON.stringify([...selected])} /><Button type="submit" class="primary-button"><Icon name="download" size={17} />Download originals</Button></form></div>{/if}
        <div class="photo-timeline" class:selecting={selected.size > 0} bind:clientWidth={galleryWidth}>
          {#each timelineGroups as group (group.key)}
          <section class="timeline-group" aria-label={group.label || 'Photos by filename'}>
            {#if group.label}<h2 class="timeline-date">{group.label}</h2>{/if}
            <div class="photo-grid" style:height={`${group.layout.containerHeight}px`}>
          {#each group.photos as photo, index (photo.id)}
            {@const box = group.layout.boxes[index]}
            {#if box}<article class:selected={selected.has(photo.id)} class:pending={photo.previewStatus !== 'ready' || imageErrors.has(photo.id)} class="photo-tile" style:left={`${box.left}px`} style:top={`${box.top}px`} style:width={`${box.width}px`} style:height={`${box.height}px`}>
              <button class="photo-open" on:click={() => openPhoto(photo)} aria-label={`Open ${photo.name}, shared by ${photo.owner}`} title={`${photo.name} · ${photo.owner}`}>
                {#if photo.previewStatus === 'ready' && !imageErrors.has(photo.id)}<Thumbnail src={mediaUrl(photo, 'thumbnail')} alt={photo.name} eager={(photoIndexes.get(photo.id) || 0) < 4} on:error={() => { imageErrors = new Set([...imageErrors, photo.id]); }} />{:else}<div class="pending-preview"><Icon name={photo.previewStatus === 'pending' ? 'clock' : 'image'} size={24} /><span>{photo.previewStatus === 'pending' ? 'Processing' : 'No preview'}</span></div>{/if}
                <span class="photo-gradient"></span><span class="photo-owner">{photo.owner}</span>
              </button>
              <label class="photo-checkbox" class:checked={selected.has(photo.id)}><input type="checkbox" checked={selected.has(photo.id)} on:change={() => toggleSelect(photo.id)} aria-label={`Select ${photo.name}`} /><span><Icon name="check" size={15} /></span></label>
              <a class="photo-download" href={mediaUrl(photo, 'original')} download={photo.name} title="Download original" aria-label={`Download ${photo.name}`}><Icon name="download" size={17} /></a>
            </article>{/if}
          {/each}
            </div>
          </section>
          {/each}
          {#if !photos.length && !loading}<div class="empty-state"><div class="empty-illustration"><span class="empty-photo"><Icon name="image" size={39} /></span><span class="empty-plus">+</span></div><Badge size="small" color="secondary">{hasSearch ? 'Nothing here yet' : 'Room for every moment'}</Badge><h2>{hasSearch ? 'No matching photos' : folder && folder !== data.user.folder ? 'Their story starts here' : 'The best memories are shared'}</h2><p>{hasSearch ? 'Try another description, adjust the filters, or explore a different folder.' : folder && folder !== data.user.folder ? `${currentOwner?.name || 'This person'} hasn’t shared any photos yet. Check back soon.` : 'Add your first photos and give everyone a new perspective. Your originals stay right here, on your server.'}</p>{#if hasSearch}<Button class="primary-button" onclick={() => { query = ''; searchFilters.reset(); }}>Clear search</Button>{:else}<Button class="primary-button" onclick={() => input.click()}><Icon name="upload" size={18} />Upload your photos</Button><span class="empty-drop-hint">or drop them anywhere on this page</span>{/if}</div>{:else if !photos.length && loading}<div class="loading-state"><span class="large-spinner"></span><p>Gathering your photos…</p></div>{/if}
        </div>
        {#if hasMore}<div class="load-more"><Button variant="outline" onclick={() => loadPhotos(true)} loading={loading}>Load more photos</Button><span>Showing {photos.length} of {total}</span></div>{/if}
      </section>
    </main>
  </div>
  <input class="sr-only" bind:this={input} type="file" multiple accept="image/*,.heic,.heif,.avif,.tif,.tiff" aria-label="Choose photos to upload" on:change={(event) => { if (event.currentTarget.files) addUploads(event.currentTarget.files); event.currentTarget.value = ''; }} />
  <dialog class="profile-dialog" bind:this={profileDialog} aria-labelledby="profile-heading">
    <button class="icon-button dialog-close" on:click={() => profileDialog.close()} aria-label="Close name settings" disabled={savingProfile}><Icon name="close" /></button>
    <span class="profile-dialog-icon"><Icon name="user" size={26} /></span>
    <h2 id="profile-heading">Make yourself at home</h2>
    <p>This is the name everyone sees beside your photos. Your uploads stay in the same folder.</p>
    <form on:submit|preventDefault={saveProfile}>
      <label for="profile-name">Display name</label>
      <input id="profile-name" type="text" bind:value={profileName} autocomplete="given-name" maxlength="80" required disabled={savingProfile} />
      {#if profileError}<p class="form-error" role="alert">{profileError}</p>{/if}
      <Button type="submit" class="primary-button" loading={savingProfile} disabled={!profileName.trim() || savingProfile}>Save name</Button>
    </form>
    <button class="text-button profile-sign-out" on:click={signOut} disabled={savingProfile}><Icon name="logout" size={17} />Sign out</button>
  </dialog>
  {#if dragging}<div class="drop-overlay"><div><span class="drop-icon"><Icon name="upload" size={42} /></span><h2>Drop your moments here</h2><p>Uploading to <strong>{data.user.name}’s folder</strong></p><span>Everyone in the collection can view and download them.</span></div></div>{/if}
  {#if uploads.length}<section class="upload-panel" bind:clientHeight={uploadPanelHeight} aria-label="Upload progress" aria-live="polite"><header><span class="upload-panel-icon"><Icon name={activeUploads ? 'upload' : 'check'} size={19} /></span><div><strong>{activeUploads ? `Uploading ${uploads.length - completedUploads} ${uploads.length - completedUploads === 1 ? 'photo' : 'photos'}` : `${completedUploads} of ${uploads.length} finished${uploads.some(item => item.duplicate) ? ` · ${uploads.filter(item => item.duplicate).length} skipped` : ''}`}</strong><span><Icon name="folder" size={12} /> Folder: {data.user.folder}/</span></div><button class="icon-button" on:click={() => { uploadPanelOpen = !uploadPanelOpen; }} aria-label={uploadPanelOpen ? 'Minimize uploads' : 'Expand uploads'}><span>{uploadPanelOpen ? '−' : '+'}</span></button>{#if !activeUploads}<button class="icon-button" on:click={() => { uploads = []; }} aria-label="Close uploads"><Icon name="close" size={17} /></button>{/if}</header>{#if uploadPanelOpen}<div class="upload-list">{#each uploads as item (item.id)}<div class="upload-row"><span class="upload-file-icon"><Icon name="image" size={21} /></span><div class="upload-item-body"><strong>{item.file.name}</strong><span class:error-text={item.status === 'error'}>{item.status === 'done' ? item.duplicate ? 'Already in collection · skipped' : 'Saved · Immich preview processing' : item.status === 'checking' ? 'Checking for duplicates…' : item.status === 'uploading' ? `${item.progress}% · ${bytes(item.file.size)}` : item.status === 'error' || item.status === 'retrying' ? item.error : item.status === 'cancelled' ? 'Cancelled' : 'Waiting to upload'}</span>{#if item.status === 'uploading'}<div class="upload-progress"><div style:width={`${item.progress}%`}></div></div>{/if}</div>{#if item.status === 'done'}<span class="upload-success"><Icon name="check" size={18} /></span>{:else if item.status === 'error' || item.status === 'cancelled'}<button class="icon-button" on:click={() => retryUpload(item)} disabled={item.file.size > data.maxUploadBytes} aria-label={`Retry ${item.file.name}`}><Icon name="refresh" size={16} /></button>{:else}<button class="icon-button" on:click={() => cancelUpload(item)} aria-label={`Cancel ${item.file.name}`}><Icon name="close" size={16} /></button>{/if}</div>{/each}</div><footer>Shared with everyone in this collection.</footer>{/if}</section>{/if}
  <dialog class="pending-dialog" bind:this={pendingDialog}><button class="icon-button dialog-close" on:click={() => pendingDialog.close()} aria-label="Close photo details"><Icon name="close" /></button>{#if pendingPhoto}<div class="dialog-image"><Icon name="image" size={52} /></div><Badge size="small" color="secondary">Original safely stored</Badge><h2>{pendingPhoto.name}</h2><p>{pendingPhoto.previewStatus === 'pending' ? 'Immich is preparing this photo’s preview. The original is already yours to enjoy.' : 'The Immich preview is currently unavailable. You can still download the original photo.'}</p><div class="dialog-metadata"><span>Shared by {pendingPhoto.owner}</span><span>{bytes(pendingPhoto.bytes)}</span></div><a class="primary-button button-link" href={mediaUrl(pendingPhoto, 'original')} download={pendingPhoto.name}><Icon name="download" size={18} />Download original</a>{/if}</dialog>
{/if}
