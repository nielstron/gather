import { readSettings } from './settings';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Photo } from '../types.js';

type Config = { url: string; key: string; library: string; root: string; signature: string };
type Asset = { id: string; width?: number; height?: number; previewReady: boolean };
type CachedAsset = { asset: Asset | null; expires: number; pendingUntil?: number };
type SearchPage = { assets: { items: unknown[]; nextCursor?: string | null; nextPage?: string | null } };
const cache = new Map<string, CachedAsset>();
const pending = new Map<string, Promise<Asset | null>>();
const CACHE_LIMIT = 2_000;
const BATCH_SIZE = 100;
const NEGATIVE_TTL = 10_000;
let signature = '';
let legacy = false;
export type LibraryScanResult = { state: 'queued' | 'scheduled' | 'unconfigured' | 'unavailable'; message?: string };
const SCAN_COOLDOWN = 30_000;
let scanSignature = '';
let lastScanAt = 0;
let lastScanResult: LibraryScanResult | undefined;
let scanInFlight: Promise<LibraryScanResult> | undefined;
let trailingScan: ReturnType<typeof setTimeout> | undefined;

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
  if (digest !== signature) {
    signature = digest;
    cache.clear();
    pending.clear();
    legacy = false;
  }
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

function remember(key: string, asset: Asset | null, pendingUntil?: number): void {
  cache.delete(key);
  cache.set(key, { asset, expires: Date.now() + (asset?.previewReady ? 60_000 : NEGATIVE_TTL), pendingUntil });
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
}

async function request(config: Config, endpoint: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
  const timeout = AbortSignal.timeout(init.method === 'POST' ? 8_000 : 20_000);
  try {
    return await fetch(`${config.url}/api${endpoint}`, {
      ...init,
      headers: { ...init.headers, 'x-api-key': config.key },
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch {
    if (signal?.aborted) throw new ImmichError(499, 'Image request cancelled.');
    throw unavailable();
  }
}

async function search(config: Config, body: object): Promise<SearchPage> {
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
  return { original: item.originalPath, asset: {
    id: item.id,
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
  if (!legacy) {
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
      legacy = true;
    }
  }
  // Legacy originalPath is a text search, so always compare returned full paths.
  // Four workers bound requests even when an older server needs one query per file.
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, paths.length) }, async () => {
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
    const known = cache.get(original);
    if (known && known.expires > Date.now()) { result.set(original, known.asset); continue; }
    const existing = pending.get(original);
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
        if (config.signature === signature) remember(original, asset);
        result.set(original, asset);
        return asset;
      }).finally(() => { if (config.signature === signature) pending.delete(original); });
      pending.set(original, promise);
      waiting.push(promise.then(() => {}));
    }
    // A gallery page cannot create an unbounded number of simultaneous API calls.
    await Promise.all(waiting);
  }
  await Promise.all(waiting);
  return result;
}

export async function enrichPhotos(photos: Photo[]): Promise<{ photos: Photo[]; previewService: 'ready' | 'unconfigured' | 'unavailable' }> {
  try {
    const config = configuration();
    if (!config) return { photos: photos.map((photo) => ({ ...photo, previewStatus: 'unavailable' })), previewService: 'unconfigured' };
    const paths = photos.map((photo) => originalPath(config, decodePhotoId(photo.id)));
    const assets = await resolveAssets(config, paths);
    return { previewService: 'ready', photos: photos.map((photo, index) => {
      const asset = assets.get(paths[index]);
      const mediaPending = (cache.get(paths[index])?.pendingUntil ?? 0) > Date.now();
      return { ...photo, width: asset?.width ?? photo.width, height: asset?.height ?? photo.height,
        previewStatus: asset?.previewReady && !mediaPending ? 'ready' : 'pending' };
    }) };
  } catch {
    return { photos: photos.map((photo) => ({ ...photo, previewStatus: 'unavailable' })), previewService: 'unavailable' };
  }
}

export async function fetchImmichImage(relativePath: string, kind: 'thumbnail' | 'preview', signal?: AbortSignal): Promise<Response> {
  const config = configuration();
  if (!config) throw new ImmichError(503, 'The host has not connected Immich previews yet.');
  if (!['thumbnail', 'preview'].includes(kind)) throw new ImmichError(400, 'Invalid image size.');
  const original = originalPath(config, relativePath);
  const asset = (await resolveAssets(config, [original])).get(original);
  if (!asset) throw new ImmichError(404, 'Photo saved. Its preview is waiting for Immich to index this folder.');
  const response = await request(config, `/assets/${asset.id}/thumbnail?size=${kind}`, {}, signal);
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 404) {
      remember(original, asset, Date.now() + NEGATIVE_TTL);
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

async function performScan(config: Config, key: string): Promise<LibraryScanResult> {
  lastScanAt = Date.now();
  const generation = scanSignature;
  const work = (async (): Promise<LibraryScanResult> => {
    try {
      const response = await request({ ...config, key }, `/libraries/${encodeURIComponent(config.library)}/scan`, { method: 'POST' });
      await response.body?.cancel();
      if (response.status !== 204) throw unavailable();
      // Retry missing mappings promptly after the scan has been queued.
      if (config.signature === signature) {
        for (const [original, entry] of cache) if (!entry.asset?.previewReady) cache.delete(original);
      }
      return { state: 'queued', message: 'Immich is scanning this shared library and will create previews for new photos.' };
    } catch {
      return { state: 'unavailable', message: 'Immich could not start the scan. The host must provide an admin API key with library.update permission.' };
    }
  })();
  scanInFlight = work;
  try {
    const result = await work;
    if (generation === scanSignature) lastScanResult = result;
    return result;
  } finally { if (generation === scanSignature) scanInFlight = undefined; }
}

/** Scan only the configured library; repeated upload batches get one trailing scan. */
export async function requestLibraryScan(): Promise<LibraryScanResult> {
  let config: Config | null;
  try { config = configuration(); } catch { return { state: 'unavailable', message: 'The Immich connection settings need attention.' }; }
  if (!config) return { state: 'unconfigured', message: 'The host has not connected Immich previews yet.' };
  const key = readSettings().immichScanApiKey || config.key;
  const current = createHash('sha256').update(config.signature).update(key).digest('hex');
  if (current !== scanSignature) {
    if (trailingScan) clearTimeout(trailingScan);
    trailingScan = undefined;
    scanInFlight = undefined;
    lastScanAt = 0;
    lastScanResult = undefined;
    scanSignature = current;
  }
  const wait = Math.max(0, SCAN_COOLDOWN - (Date.now() - lastScanAt));
  if (scanInFlight || wait > 0) {
    if (!scanInFlight && lastScanResult?.state === 'unavailable') return lastScanResult;
    if (!trailingScan) {
      const captured = config;
      trailingScan = setTimeout(() => {
        trailingScan = undefined;
        if (scanSignature !== current) return;
        void performScan(captured, key).then((result) => {
          if (result.state === 'unavailable') console.warn('Gather: scheduled Immich library scan failed; check the admin scan API key and Immich connection.');
        });
      }, Math.max(wait, 100));
      trailingScan.unref();
    }
    return { state: 'scheduled', message: 'A scan is scheduled shortly to include the latest uploads.' };
  }
  return performScan(config, key);
}
