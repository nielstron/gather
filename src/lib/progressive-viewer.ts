import type PhotoSwipe from 'photoswipe';
import { createLimiter } from './async';
import { retainThumbnail, type ThumbnailLease } from './thumbnail-cache';

type Slide = NonNullable<PhotoSwipe['currSlide']>;
type Content = Slide['content'];
type Entry = {
  element: HTMLImageElement;
  preview: AbortController;
  full?: AbortController;
  level: number;
  urls: Set<string>;
  thumbnailFailed: boolean;
  previewFailed: boolean;
  lastFullAttempt: number;
};

/** Keep a visible image throughout thumbnail -> preview -> full-size upgrades. */
export function installProgressiveImages(viewer: PhotoSwipe) {
  const previews = createLimiter(2);
  const entries = new Map<Content, Entry>();
  const thumbnails = new Map<Content, ThumbnailLease>();
  let destroyed = false;

  function thumbnail(content: Content): string {
    if (!thumbnails.has(content) && content.data.thumbnailSrc) {
      const lease = retainThumbnail(content.data.thumbnailSrc as string);
      if (lease) thumbnails.set(content, lease);
    }
    return thumbnails.get(content)?.url || content.data.msrc || '';
  }

  function dispose(content: Content) {
    const entry = entries.get(content);
    if (entry) {
      entry.preview.abort(); entry.full?.abort();
      for (const url of entry.urls) URL.revokeObjectURL(url);
      entries.delete(content);
    }
    thumbnails.get(content)?.release(); thumbnails.delete(content);
  }

  async function upgrade(content: Content, entry: Entry, source: string, level: number, controller: AbortController) {
    let url: string | undefined;
    try {
      const response = await fetch(source, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(level === 2 ? 90000 : 20000)]) });
      if (!response.ok) throw new Error('Image unavailable');
      url = URL.createObjectURL(await response.blob());
      const image = new Image();
      image.src = url;
      await image.decode();
      if (destroyed || controller.signal.aborted || entries.get(content) !== entry || entry.level >= level) return;
      entry.urls.add(url);
      entry.level = level;
      entry.element.src = url;
      entry.element.dataset.resolution = level === 2 ? 'fullsize' : 'preview';
      content.onLoaded();
      url = undefined; // owned by the content until it is evicted or the viewer closes
      if (level === 2) entry.preview.abort();
    } catch {
      if (level === 1 && !controller.signal.aborted && entries.get(content) === entry) {
        entry.previewFailed = true;
        if (entry.thumbnailFailed && entry.level === 0) content.onError();
      }
      // A failed upgrade leaves the currently visible image in place.
    } finally { if (url) URL.revokeObjectURL(url); }
  }

  viewer.addFilter('placeholderSrc', (_source, content) => thumbnail(content) || false);
  viewer.on('contentLoadImage', event => {
    const { content } = event;
    if (!(content.element instanceof HTMLImageElement)) return;
    event.preventDefault();
    if (entries.get(content)?.element === content.element) return;
    if (entries.has(content)) dispose(content);
    const entry: Entry = { element: content.element, preview: new AbortController(), level: 0, urls: new Set(), thumbnailFailed: false, previewFailed: false, lastFullAttempt: 0 };
    entries.set(content, entry);
    const element = entry.element;
    element.alt = content.data.alt || '';
    element.dataset.resolution = 'thumbnail';
    content.state = 'loading';
    element.onload = () => { if (!destroyed && entries.get(content) === entry) content.onLoaded(); };
    element.onerror = () => {
      entry.thumbnailFailed = true;
      if (entry.previewFailed && entry.level === 0) content.onError();
    };
    element.src = thumbnail(content);
    if (element.complete && element.naturalWidth) content.onLoaded();
    void previews(async () => {
      if (!entry.preview.signal.aborted && content.data.src) await upgrade(content, entry, content.data.src, 1, entry.preview);
    });
  });

  function fullSize(slide: Slide | undefined) {
    if (!slide || destroyed) return;
    const content = slide.content;
    const entry = entries.get(content);
    if (!entry || entry.level === 2 || entry.full || !content.data.fullSrc || Date.now() - entry.lastFullAttempt < 10000) return;
    entry.lastFullAttempt = Date.now();
    const controller = new AbortController();
    entry.full = controller;
    void upgrade(content, entry, content.data.fullSrc as string, 2, controller).finally(() => { if (entry.full === controller) entry.full = undefined; });
  }

  viewer.on('beforeZoomTo', ({ destZoomLevel }) => {
    if (viewer.currSlide && destZoomLevel > viewer.currSlide.zoomLevels.initial + 0.001) fullSize(viewer.currSlide);
  });
  viewer.on('zoomPanUpdate', ({ slide }) => {
    if (slide.currZoomLevel > slide.zoomLevels.initial + 0.001) fullSize(slide);
  });
  viewer.on('change', () => {
    for (const [content, entry] of entries) if (content !== viewer.currSlide?.content && entry.full) {
      entry.full.abort(); entry.full = undefined; entry.lastFullAttempt = 0;
    }
  });
  viewer.on('contentDestroy', ({ content }) => dispose(content));
  viewer.on('destroy', () => {
    destroyed = true;
    for (const content of new Set([...entries.keys(), ...thumbnails.keys()])) dispose(content);
  });
}
