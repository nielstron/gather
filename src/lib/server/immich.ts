import { readSettings } from './settings';
import { createLimiter, mapConcurrent } from '../async';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Photo } from '../types.js';
import { filenameCaptureDate } from '../photo-date';

type Config = { url: string; key: string; library: string; root: string; signature: string };
type Asset = { id: string; width?: number; height?: number; previewReady: boolean; takenAt?: string; hasCaptureDate?: boolean };
type CachedAsset = { asset: Asset | null; expires: number; pendingUntil?: number };
type SearchPage = { assets: { items: unknown[]; nextCursor?: string | null; nextPage?: string | null } };
const cache = new Map<string, CachedAsset>();
const pending = new Map<string, Promise<Asset | null>>();
const CACHE_LIMIT = 2_000;
const BATCH_SIZE = 100;
const NEGATIVE_TTL = 10_000;
const metadataRequests = createLimiter(8);
const portraitRequests = createLimiter(4);
const legacyConfigurations = new Set<string>();
export type LibraryScanResult = { state: 'queued' | 'scheduled' | 'unconfigured' | 'unavailable'; message?: string };
const SCAN_COOLDOWN = 30_000;
type ScanState = { lastAt: number; result?: LibraryScanResult; inFlight?: Promise<LibraryScanResult>; trailing?: ReturnType<typeof setTimeout> };
const scanStates = new Map<string, ScanState>();

export class ImmichError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ImmichError';
  }
}

function unavailable(): ImmichError {
  return new ImmichError(503, 'Immich previews are unavailable. The host can check the connection and API permissions.');
}

function configuration(): Config | null {
  const { immichUrl: IMMICH_URL, immichApiKey: IMMICH_API_KEY, immichLibraryId: IMMICH_LIBRARY_ID, immichPhotoRoot: IMMICH_PHOTO_ROOT } = readSettings();
  if (!IMMICH_URL || !IMMICH_API_KEY || !IMMICH_LIBRARY_ID || !IMMICH_PHOTO_ROOT) return null;
  let url: URL;
  try { url = new URL(IMMICH_URL); } catch { throw unavailable(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw unavailable();
  const root = path.posix.normalize(IMMICH_PHOTO_ROOT);
  if (!path.posix.isAbsolute(root) || IMMICH_PHOTO_ROOT.includes('\\') || IMMICH_PHOTO_ROOT.includes('\0')) throw unavailable();
  const base = url.toString().replace(/\/+$/, '').replace(/\/api$/, '');
  const digest = createHash('sha256').update(JSON.stringify([base, IMMICH_API_KEY, IMMICH_LIBRARY_ID, root])).digest('hex');
  return { url: base, key: IMMICH_API_KEY, library: IMMICH_LIBRARY_ID, root, signature: digest };
}

function originalPath(config: Config, relative: string): string {
  if (!relative || relative.length > 4096 || relative.includes('\\') || relative.includes('\0') || relative.startsWith('/') || relative.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new ImmichError(400, 'Invalid photo path.');
  }
  return path.posix.join(config.root, relative);
}

function decodePhotoId(id: string): string {
  const bytes = Buffer.from(id, 'base64url');
  if (!id || bytes.toString('base64url') !== id) throw new ImmichError(400, 'Invalid photo identifier.');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new ImmichError(400, 'Invalid photo identifier.'); }
}

function assetKey(config: Config, original: string) { return `${config.signature}:${original}`; }

function remember(config: Config, original: string, asset: Asset | null, pendingUntil?: number): void {
  const key = assetKey(config, original);
  cache.delete(key);
  cache.set(key, { asset, expires: Date.now() + (asset?.previewReady ? 60_000 : NEGATIVE_TTL), pendingUntil });
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
}

async function request(config: Config, endpoint: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
  const fullSize = endpoint.startsWith('/assets/') && (endpoint.endsWith('/original') || endpoint.includes('size=fullsize'));
  const timeout = AbortSignal.timeout(endpoint === '/search/smart' ? 25_000 : init.method === 'POST' ? 8_000 : fullSize ? 90_000 : 20_000);
  try {
    return await fetch(`${config.url}/api${endpoint}`, {
      ...init,
      headers: { ...init.headers, 'x-api-key': config.key },
      redirect: init.redirect || 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch {
    if (signal?.aborted) throw new ImmichError(499, 'Image request cancelled.');
    throw unavailable();
  }
}

function search(config: Config, body: object): Promise<SearchPage> {
  return metadataRequests(() => searchPage(config, body));
}

async function searchPage(config: Config, body: object): Promise<SearchPage> {
  const response = await request(config, '/search/metadata', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!response.ok) {
    await response.body?.cancel();
    // Only schema rejection may switch to the older request format.
    throw new ImmichError(response.status === 400 ? 400 : 503, unavailable().message);
  }
  try {
    const page = await response.json() as SearchPage;
    if (!page || !Array.isArray(page.assets?.items)) throw unavailable();
    return page;
  } catch { throw unavailable(); }
}

function matchedAsset(value: unknown, config: Config, requested: Set<string>): { original: string; asset: Asset } | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  if (item.libraryId !== config.library || typeof item.originalPath !== 'string' || !requested.has(item.originalPath) || typeof item.id !== 'string' || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(item.id) || item.isOffline === true || item.isTrashed === true) return null;
  const exif = item.exifInfo as Record<string, unknown> | undefined;
  let width = Number(item.width ?? exif?.exifImageWidth);
  let height = Number(item.height ?? exif?.exifImageHeight);
  if (item.width == null && [5, 6, 7, 8].includes(Number(exif?.orientation))) [width, height] = [height, width];
  const exifDate = typeof exif?.dateTimeOriginal === 'string' && Number.isFinite(Date.parse(exif.dateTimeOriginal)) ? exif.dateTimeOriginal : undefined;
  const localDate = typeof item.localDateTime === 'string' && Number.isFinite(Date.parse(item.localDateTime)) ? item.localDateTime.replace(/Z$/, '') : undefined;
  const fallbackDate = typeof item.fileCreatedAt === 'string' && Number.isFinite(Date.parse(item.fileCreatedAt)) ? item.fileCreatedAt : undefined;
  return { original: item.originalPath, asset: {
    id: item.id, takenAt: localDate || exifDate || fallbackDate, hasCaptureDate: !!exifDate || !!localDate,
    width: Number.isFinite(width) && width > 0 ? width : undefined,
    height: Number.isFinite(height) && height > 0 ? height : undefined,
    // Current Immich explicitly returns null until a thumbnail has a thumbhash.
    // Older responses may omit this field; the media endpoint remains authoritative.
    previewReady: item.thumbhash !== null,
  } };
}

async function queryBatch(config: Config, paths: string[]): Promise<Map<string, Asset>> {
  const requested = new Set(paths);
  const found = new Map<string, Asset>();
  const accept = (items: unknown[]) => {
    for (const value of items) {
      const match = matchedAsset(value, config, requested);
      if (match) found.set(match.original, match.asset);
    }
  };
  if (!legacyConfigurations.has(config.signature)) {
    try {
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const result = await search(config, { size: 1000, withExif: true, withPeople: false,
          filter: { libraryId: { eq: config.library }, originalPath: { in: paths } }, ...(cursor ? { cursor } : {}),
        });
        accept(result.assets.items);
        if (!result.assets.nextCursor) return found;
        if (result.assets.nextCursor === cursor) throw unavailable();
        cursor = result.assets.nextCursor;
      }
      throw unavailable();
    } catch (error) {
      if (!(error instanceof ImmichError) || error.status !== 400) throw error;
      legacyConfigurations.add(config.signature);
    }
  }
  // Legacy originalPath is a text search, so always compare returned full paths.
  // Concurrent workers bound requests even when an older server needs one query per file.
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, paths.length) }, async () => {
    while (next < paths.length) {
      const original = paths[next++];
      let page = 1;
      for (let attempts = 0; attempts < 10; attempts++) {
        const result = await search(config, { originalPath: original, libraryId: config.library,
          size: 1000, page, withExif: true, withPeople: false,
        });
        accept(result.assets.items);
        if (!result.assets.nextPage) break;
        const nextPage = Number(result.assets.nextPage);
        if (!Number.isSafeInteger(nextPage) || nextPage <= page || attempts === 9) throw unavailable();
        page = nextPage;
      }
    }
  }));
  return found;
}

async function resolveAssets(config: Config, paths: string[]): Promise<Map<string, Asset | null>> {
  const result = new Map<string, Asset | null>();
  const missing: string[] = [];
  const waiting: Promise<void>[] = [];
  for (const original of new Set(paths)) {
    const known = cache.get(assetKey(config, original));
    if (known && known.expires > Date.now()) { result.set(original, known.asset); continue; }
    const existing = pending.get(assetKey(config, original));
    if (existing) waiting.push(existing.then((asset) => { result.set(original, asset); }));
    else missing.push(original);
  }
  // Limit cache growth and requests to the current gallery page, in batches of 100.
  for (let start = 0; start < missing.length; start += BATCH_SIZE) {
    const batch = missing.slice(start, start + BATCH_SIZE);
    const lookup = queryBatch(config, batch);
    for (const original of batch) {
      const promise = lookup.then((found) => {
        const asset = found.get(original) ?? null;
        remember(config, original, asset);
        result.set(original, asset);
        return asset;
      }).finally(() => { pending.delete(assetKey(config, original)); });
      pending.set(assetKey(config, original), promise);
      waiting.push(promise.then(() => {}));
    }
    // Start independent batches together; the shared metadata limiter bounds API traffic.
  }
  await Promise.all(waiting);
  return result;
}

// Capture dates are retained independently of short-lived preview mappings. This
// keeps global sorting correct before pagination without rereading original files.
const captureDates = new Map<string, { revision?: string; takenAt?: string; expires: number }>();
function preferredDate(photo: Photo, asset?: Asset | null) {
  return asset?.hasCaptureDate ? asset.takenAt : photo.takenAt || filenameCaptureDate(photo.name) || asset?.takenAt;
}
export async function enrichPhotoDates(photos: Photo[]): Promise<Photo[]> {
  let config: Config | null;
  try { config = configuration(); } catch { return photos; }
  if (!config || !photos.length) return photos;
  const current = config;
  const key = (photo: Photo) => assetKey(current, originalPath(current, decodePhotoId(photo.id)));
  const missing = photos.filter(photo => { const date = captureDates.get(key(photo)); return !date || date.revision !== photo.revision || date.expires < Date.now(); });
  if (missing.length) {
    const work = resolveAssets(current, missing.map(photo => originalPath(current, decodePhotoId(photo.id)))).then(assets => {
      for (const photo of missing) {
        const asset = assets.get(originalPath(current, decodePhotoId(photo.id)));
        captureDates.set(key(photo), { revision: photo.revision, takenAt: preferredDate(photo, asset), expires: Date.now() + (asset?.hasCaptureDate ? 300_000 : 10_000) });
      }
      while (captureDates.size > 20_000) captureDates.delete(captureDates.keys().next().value!);
    }).catch(() => {});
    let deadline: ReturnType<typeof setTimeout>;
    await Promise.race([work, new Promise<void>(resolve => { deadline = setTimeout(resolve, 2000); })]).finally(() => clearTimeout(deadline));
  }
  return photos.map(photo => {
    const date = captureDates.get(key(photo));
    return date?.revision === photo.revision && date?.takenAt ? { ...photo, takenAt: date.takenAt } : photo;
  });
}

export async function enrichPhotos(photos: Photo[]): Promise<{ photos: Photo[]; previewService: 'ready' | 'unconfigured' | 'unavailable' }> {
  try {
    const config = configuration();
    if (!config) return { photos: photos.map((photo) => ({ ...photo, previewStatus: 'unavailable' })), previewService: 'unconfigured' };
    const paths = photos.map((photo) => originalPath(config, decodePhotoId(photo.id)));
    let deadline: ReturnType<typeof setTimeout>;
    const assets = await Promise.race([resolveAssets(config, paths), new Promise<null>(resolve => {
      deadline = setTimeout(() => resolve(null), 2000);
    })]).finally(() => clearTimeout(deadline)) ?? new Map(paths.map(original => [original, cache.get(assetKey(config, original))?.asset ?? null]));
    return { previewService: 'ready', photos: photos.map((photo, index) => {
      const asset = assets.get(paths[index]);
      const mediaPending = (cache.get(assetKey(config, paths[index]))?.pendingUntil ?? 0) > Date.now();
      return { ...photo, ...(preferredDate(photo, asset) ? { takenAt: preferredDate(photo, asset) } : {}), width: asset?.width ?? photo.width, height: asset?.height ?? photo.height,
        previewStatus: asset?.previewReady && !mediaPending ? 'ready' : 'pending' };
    }) };
  } catch {
    return { photos: photos.map((photo) => ({ ...photo, previewStatus: 'unavailable' })), previewService: 'unavailable' };
  }
}

export async function fetchImmichImage(relativePath: string, kind: 'thumbnail' | 'preview' | 'fullsize', signal?: AbortSignal): Promise<Response> {
  const config = configuration();
  if (!config) throw new ImmichError(503, 'The host has not connected Immich previews yet.');
  if (!['thumbnail', 'preview', 'fullsize'].includes(kind)) throw new ImmichError(400, 'Invalid image size.');
  const original = originalPath(config, relativePath);
  const asset = (await resolveAssets(config, [original])).get(original);
  if (!asset) throw new ImmichError(404, 'Photo saved. Its preview is waiting for Immich to index this folder.');
  let response = await request(config, `/assets/${asset.id}/thumbnail?size=${kind}`, kind === 'fullsize' ? { redirect: 'manual' } : {}, signal);
  if (kind === 'fullsize' && [301, 302, 303, 307, 308].includes(response.status)) {
    const source = `${config.url}/api/assets/${asset.id}/thumbnail?size=fullsize`;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) throw unavailable();
    const target = new URL(location, source);
    const original = new URL(`${config.url}/api/assets/${asset.id}/original`);
    const preview = new URL(`${config.url}/api/assets/${asset.id}/thumbnail?size=preview`);
    if (target.origin !== original.origin || target.hash || target.username || target.password) throw unavailable();
    if (target.pathname === original.pathname && (!target.search || target.search === '?')) response = await request(config, `/assets/${asset.id}/original`, {}, signal);
    else if (target.href === preview.href) response = await request(config, `/assets/${asset.id}/thumbnail?size=preview`, {}, signal);
    else throw unavailable();
  }
  if (kind === 'fullsize' && response.status === 400) {
    await response.body?.cancel();
    response = await request(config, `/assets/${asset.id}/thumbnail?size=preview`, {}, signal);
  }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 404) {
      remember(config, original, asset, Date.now() + NEGATIVE_TTL);
      throw new ImmichError(404, 'Photo saved. Immich has not made this preview available yet.');
    }
    throw unavailable();
  }
  const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (!contentType || !['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif'].includes(contentType) || !response.body) {
    await response.body?.cancel();
    throw unavailable();
  }
  return new Response(response.body, { headers: {
    'content-type': contentType, 'cache-control': 'private, max-age=60', 'x-content-type-options': 'nosniff',
  } });
}

async function performScan(config: Config, key: string, state: ScanState): Promise<LibraryScanResult> {
  state.lastAt = Date.now();
  const work = (async (): Promise<LibraryScanResult> => {
    try {
      let scoped = process.env.IMMICH_SCAN_MODE !== 'library';
      const endpoint = `/libraries/${encodeURIComponent(config.library)}/scan${scoped ? '/path' : ''}`;
      let response = await request({ ...config, key }, endpoint, scoped ? {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: config.root }),
      } : { method: 'POST' });
      await response.body?.cancel();
      if (scoped && response.status === 404) {
        scoped = false;
        response = await request({ ...config, key }, `/libraries/${encodeURIComponent(config.library)}/scan`, { method: 'POST' });
        await response.body?.cancel();
      }
      if (response.status !== 204) throw unavailable();
      // Retry missing mappings promptly after the scan has been queued.
      for (const [original, entry] of cache) if (original.startsWith(`${config.signature}:`) && !entry.asset?.previewReady) cache.delete(original);
      return { state: 'queued', message: scoped ? 'Immich is scanning only the selected shared folder and will create previews for new photos.' : 'Immich is scanning the configured library and will create previews for new photos.' };
    } catch {
      return { state: 'unavailable', message: 'Immich could not start the scan. The host must provide an admin API key with library.update permission.' };
    }
  })();
  state.inFlight = work;
  try {
    const result = await work;
    state.result = result;
    return result;
  } finally { if (state.inFlight === work) state.inFlight = undefined; }
}

/** Scan only the configured library; repeated upload batches get one trailing scan. */
export async function requestLibraryScan(): Promise<LibraryScanResult> {
  let config: Config | null;
  try { config = configuration(); } catch { return { state: 'unavailable', message: 'The Immich connection settings need attention.' }; }
  if (!config) return { state: 'unconfigured', message: 'The host has not connected Immich previews yet.' };
  const key = readSettings().immichScanApiKey || config.key;
  const current = createHash('sha256').update(config.signature).update(key).update(process.env.IMMICH_SCAN_MODE || 'path').digest('hex');
  let state = scanStates.get(current);
  if (!state) { state = { lastAt: 0 }; scanStates.set(current, state); }
  const capturedState = state;
  const wait = Math.max(0, SCAN_COOLDOWN - (Date.now() - state.lastAt));
  if (state.inFlight || wait > 0) {
    if (!state.inFlight && state.result?.state === 'unavailable') return state.result;
    if (!state.trailing) {
      const captured = config;
      state.trailing = setTimeout(() => {
        capturedState.trailing = undefined;
        void performScan(captured, key, capturedState).then((result) => {
          if (result.state === 'unavailable') console.warn('Gather: scheduled Immich library scan failed; check the admin scan API key and Immich connection.');
        });
      }, Math.max(wait, 100));
      state.trailing.unref();
    }
    return { state: 'scheduled', message: 'A scan is scheduled shortly to include the latest uploads.' };
  }
  return performScan(config, key, state);
}

// Search credentials and raw Immich records never leave the server. Every accepted
// result must match both the configured library and a currently shared file.
const collectionSearchCache = new Map<string, { expires: number; items: Record<string, unknown>[]; truncated: boolean }>();
const collectionSearchPending = new Map<string, Promise<{ items: Record<string, unknown>[]; truncated: boolean }>>();

async function searchSharedAssets(photos: Photo[], options: import('../search').CollectionSearch, query: string, people: boolean, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const config = configuration();
  if (!config) throw new ImmichError(503, 'Connect Immich in collection settings to use semantic search and filters.');
  if (!photos.length) return { items: [], truncated: false };
  const requested = new Set(photos.map(photo => originalPath(config, decodePhotoId(photo.id))));
  const filter = structuredClone(options.filter || {}) as Record<string, any>;
  if (filter.libraryId?.eq !== undefined && filter.libraryId.eq !== config.library || filter.libraryId?.ne === config.library) return { items: [], truncated: false };
  filter.libraryId = { eq: config.library };
  const paths = filter.originalPath?.in ? [...requested].filter(original => filter.originalPath.in.includes(original)) : [...requested];
  if (!paths.length) return { items: [], truncated: false };
  filter.originalPath = { ...filter.originalPath, in: paths };
  if (query && options.mode === 'metadata') {
    if (filter.description?.like !== undefined) throw new ImmichError(400, 'Use either a description search or a description pattern condition.');
    filter.description = { ...filter.description, like: `%${query}%` };
  }
  const semantic = !people && options.mode === 'semantic' && !!(query || options.queryAssetId);
  const body: Record<string, unknown> = { filter, size: semantic ? options.resultLimit || 1000 : 1000, withExif: !people,
    ...(semantic ? { ...(query ? { query } : {}), ...(options.queryAssetId ? { queryAssetId: options.queryAssetId } : {}), ...(options.language ? { language: options.language } : {}) }
      : { withPeople: people, withStacked: people ? true : options.withStacked ?? true, ...(options.orderBy ? { orderBy: options.orderBy } : {}) }) };
  // Similarity references must themselves belong to the shared folder.
  if (semantic && options.queryAssetId) {
    const indexed = await resolveAssets(config, [...requested]);
    if (![...indexed.values()].some(asset => asset?.id === options.queryAssetId)) throw new ImmichError(400, 'The reference image must belong to this shared collection.');
  }
  const key = createHash('sha256').update(JSON.stringify([config.signature, body, photos.map(photo => [photo.id, photo.revision])])).digest('hex');
  const known = collectionSearchCache.get(key);
  if (known && known.expires > Date.now()) return known;
  let work = collectionSearchPending.get(key);
  if (!work) {
    work = (async () => {
      const searchSignal = AbortSignal.timeout(25_000);
      const items: Record<string, unknown>[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 25; page++) {
        const response = await metadataRequests(() => request(config, semantic ? '/search/smart' : '/search/metadata', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, ...(cursor ? { cursor } : {}) })
        }, searchSignal));
        if (!response.ok) {
          await response.body?.cancel();
          throw new ImmichError(response.status === 400 ? 400 : 503, response.status === 400
            ? 'Immich could not run this search. Check the filters and that smart search is enabled. Structured filters require Immich 3.2 or newer.'
            : 'Immich search is temporarily unavailable. Please try again.');
        }
        const result = await response.json() as SearchPage;
        if (!Array.isArray(result?.assets?.items)) throw new ImmichError(503, 'Immich returned an invalid search response.');
        for (const value of result.assets.items) {
          const match = matchedAsset(value, config, requested);
          if (!match) continue;
          remember(config, match.original, match.asset);
          // Retain only what this feature needs, rather than whole EXIF/owner records.
          items.push({ id: match.asset.id, originalPath: match.original, ...(people ? { people: (value as Record<string, unknown>).people } : {}) });
        }
        if (semantic || !result.assets.nextCursor) {
          const value = { items, truncated: semantic && result.assets.items.length >= Number(body.size) };
          collectionSearchCache.set(key, { ...value, expires: Date.now() + (people ? 60_000 : 15_000) });
          while (collectionSearchCache.size > 24) collectionSearchCache.delete(collectionSearchCache.keys().next().value!);
          return value;
        }
        if (cursor === result.assets.nextCursor) break;
        cursor = result.assets.nextCursor;
      }
      throw new ImmichError(503, 'This search returned too many pages. Please narrow the filters.');
    })().catch(error => {
      if (error instanceof ImmichError && error.status === 400) throw error;
      throw new ImmichError(503, 'Immich search is taking too long or is temporarily unavailable. Please try again.');
    }).finally(() => collectionSearchPending.delete(key));
    collectionSearchPending.set(key, work);
  }
  if (!signal) return work;
  signal.throwIfAborted();
  // Searches are shared across gallery pages; cancelling one waiter must not cancel others.
  return new Promise<Awaited<typeof work>>((resolve, reject) => {
    const abort = () => reject(new ImmichError(499, 'Search cancelled.'));
    signal.addEventListener('abort', abort, { once: true });
    work!.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export async function searchCollection(photos: Photo[], query: string, options: import('../search').CollectionSearch, signal?: AbortSignal): Promise<{ photos: Photo[]; truncated: boolean }> {
  const local = options.mode === 'filename' && query
    ? photos.filter(photo => `${photo.name} ${photo.owner}`.toLowerCase().includes(query.toLowerCase())) : photos;
  if (!Object.keys(options.filter || {}).length && !options.queryAssetId && (!query || options.mode === 'filename') && !options.orderBy && options.withStacked === undefined) return { photos: local, truncated: false };
  const result = await searchSharedAssets(local, options, options.mode === 'filename' ? '' : query, false, signal);
  const config = configuration()!;
  const byPath = new Map(local.map(photo => [originalPath(config, decodePhotoId(photo.id)), photo]));
  const seen = new Set<string>();
  return { photos: result.items.flatMap(item => {
    const photo = byPath.get(item.originalPath as string);
    if (!photo || seen.has(photo.id)) return [];
    seen.add(photo.id);
    return [photo];
  }), truncated: result.truncated };
}

export async function collectionPeople(photos: Photo[], signal?: AbortSignal): Promise<import('../search').SearchPerson[]> {
  const result = await searchSharedAssets(photos, { mode: 'metadata' }, '', true, signal);
  const config = configuration()!;
  const byPath = new Map(photos.map(photo => [originalPath(config, decodePhotoId(photo.id)), photo]));
  const people = new Map<string, import('../search').SearchPerson>();
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const item of result.items) {
    const photo = byPath.get(item.originalPath as string);
    if (!photo || !Array.isArray(item.people)) continue;
    for (const person of item.people) {
      if (!person || typeof person.id !== 'string' || !uuid.test(person.id) || person.isHidden) continue;
      const current = people.get(person.id);
      if (current) { current.count++; continue; }
      people.set(person.id, { id: person.id, name: typeof person.name === 'string' ? person.name.slice(0, 200) : '', photoId: photo.id, revision: photo.revision, count: 1 });
    }
  }
  return [...people.values()].sort((a, b) => Number(!!b.name) - Number(!!a.name) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export async function personThumbnail(personId: string, photos: Photo[], signal?: AbortSignal): Promise<Response> {
  if (!(await collectionPeople(photos, signal)).some(person => person.id === personId)) throw new ImmichError(404, 'Person not found in this collection.');
  const config = configuration()!;
  const response = await portraitRequests(() => request(config, `/people/${encodeURIComponent(personId)}/thumbnail`, {}, signal));
  if (!response.ok) { await response.body?.cancel(); throw new ImmichError(response.status === 404 ? 404 : 503, 'Person thumbnail is unavailable. The integration key needs person.read.'); }
  const contentType = response.headers.get('content-type')?.split(';')[0].toLowerCase();
  if (!contentType?.startsWith('image/')) { await response.body?.cancel(); throw unavailable(); }
  return new Response(response.body, { headers: { 'Content-Type': contentType, 'Cache-Control': 'private, max-age=60' } });
}

const informationCache = new Map<string, { expires: number; value: import('../types').PhotoInformation }>();
/** Read indexed metadata from Immich; never parse originals or expose internal paths. */
export async function photoInformation(relative: string, revision: string, signal?: AbortSignal): Promise<import('../types').PhotoInformation> {
  const config = configuration();
  if (!config) return { state: 'unconfigured' };
  const original = originalPath(config, relative), key = `${assetKey(config, original)}:${revision}`;
  const cached = informationCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;
  const asset = (await resolveAssets(config, [original])).get(original);
  if (!asset) return { state: 'pending' };
  const response = await metadataRequests(() => request(config, `/assets/${asset.id}`, {}, AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(6_000)])));
  if (!response.ok) { await response.body?.cancel(); throw new ImmichError(503, 'Photo information is unavailable. Check the Immich integration key and connection.'); }
  const item = await response.json() as Record<string, any>;
  if (!matchedAsset(item, config, new Set([original]))) throw new ImmichError(404, 'Photo information does not belong to this collection.');
  const exif = item.exifInfo && typeof item.exifInfo === 'object' ? item.exifInfo : {};
  const metadata: import('../types').PhotoMetadata = { people: [], tags: [] };
  for (const field of ['description', 'timeZone', 'make', 'model', 'lensModel', 'exposureTime', 'city', 'state', 'country'] as const) {
    if (typeof exif[field] === 'string' && exif[field].trim()) metadata[field] = exif[field].trim().slice(0, field === 'description' ? 4000 : 300);
  }
  for (const field of ['fNumber', 'focalLength', 'iso', 'rating'] as const) if (typeof exif[field] === 'number' && Number.isFinite(exif[field]) && exif[field] > 0) metadata[field] = exif[field];
  if (typeof exif.latitude === 'number' && typeof exif.longitude === 'number' && Number.isFinite(exif.latitude) && Number.isFinite(exif.longitude) && Math.abs(exif.latitude) <= 90 && Math.abs(exif.longitude) <= 180) { metadata.latitude = exif.latitude; metadata.longitude = exif.longitude; }
  const matched = matchedAsset(item, config, new Set([original]))!.asset;
  if (matched.hasCaptureDate) metadata.takenAt = matched.takenAt;
  metadata.width = matched.width; metadata.height = matched.height;
  if (typeof item.originalMimeType === 'string') metadata.mimeType = item.originalMimeType.slice(0, 100);
  if (Array.isArray(item.people)) metadata.people = item.people.filter((person: any) => person && !person.isHidden && typeof person.id === 'string' && /^[\da-f-]{36}$/i.test(person.id)).slice(0, 100).map((person: any) => ({ id: person.id, name: typeof person.name === 'string' ? person.name.slice(0, 200) : '' }));
  if (Array.isArray(item.tags)) metadata.tags = item.tags.filter((tag: any) => tag && typeof tag.value === 'string').slice(0, 100).map((tag: any) => tag.value.slice(0, 200));
  const value = { state: 'ready' as const, metadata };
  informationCache.set(key, { value, expires: Date.now() + 60_000 });
  while (informationCache.size > 500) informationCache.delete(informationCache.keys().next().value!);
  return value;
}

/** Stream Immich's compatible video rendition, preserving seeking and cancellation. */
export async function fetchImmichVideo(relative: string, range: string | null, signal: AbortSignal): Promise<Response> {
  const config = configuration();
  if (!config) throw new ImmichError(503, 'Video playback needs an Immich connection. Download the original instead.');
  if (range && (range.length > 100 || !/^bytes=(?:\d+-\d*|-\d+)$/.test(range))) throw new ImmichError(416, 'Invalid video byte range.');
  const original = originalPath(config, relative), asset = (await resolveAssets(config, [original])).get(original);
  if (!asset) throw new ImmichError(404, 'The video is waiting for Immich to index it. Download the original or retry shortly.');
  const headersTimeout = new AbortController();
  const timer = setTimeout(() => headersTimeout.abort(), 15_000);
  let response: Response;
  try {
    response = await fetch(`${config.url}/api/assets/${asset.id}/video/playback`, { headers: { 'x-api-key': config.key, ...(range ? { Range: range } : {}) }, redirect: 'error', signal: AbortSignal.any([signal, headersTimeout.signal]) });
  } catch { throw new ImmichError(503, 'Video playback is temporarily unavailable. Download the original or retry shortly.'); }
  finally { clearTimeout(timer); }
  const headers = new Headers({ 'Cache-Control': 'private, max-age=60' });
  for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    const value = response.headers.get(name); if (value) headers.set(name, value);
  }
  if (response.status === 416) { await response.body?.cancel(); return new Response(null, { status: 416, headers }); }
  if (![200, 206].includes(response.status) || !response.headers.get('content-type')?.startsWith('video/')) { await response.body?.cancel(); throw new ImmichError(503, 'This video is still processing or unavailable. Download the original or retry shortly.'); }
  return new Response(response.body, { status: response.status, headers });
}
