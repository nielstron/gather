import { constants, createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, lstat, open, link, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import sharp from 'sharp';
import { currentCollectionId } from './settings';
import { config } from './config';
import { readFileChecksum, writeFileChecksum } from './auth';
import { createLimiter, createWeightedLimiter, runConcurrentQueue, mapConcurrent } from '../async';
import type { Member, Photo } from '../types';

const extensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif', '.tif', '.tiff', '.heic', '.heif']);
const formats = new Set(['jpeg', 'png', 'webp', 'avif', 'gif', 'tiff', 'heif']);
type ScanCache = { root: string; time: number; photos: Photo[]; ids: Set<string> };
type ScanState = { cache?: ScanCache; scanning?: Promise<Photo[]>; generation: number; uploaded?: Map<string, Photo> };
const scans = new Map<string, ScanState>();
// Leave filesystem workers available for uploads, downloads and DNS on slow mounts.
const scanRequests = createLimiter(4);
// Bound decoded pixels, while smaller images and network transfers stay parallel.
const validateImage = createWeightedLimiter(48_000_000);
function scanState(): ScanState {
  let state = scans.get(config.photoRoot);
  if (!state) {
    state = { generation: 0 }; scans.set(config.photoRoot, state);
    if (scans.size > 16) {
      for (const [root, cached] of scans) {
        if (root !== config.photoRoot && !cached.scanning) { scans.delete(root); break; }
      }
    }
  }
  return state;
}

export class MediaError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function encodeId(relative: string) { return Buffer.from(relative).toString('base64url'); }

export function decodeId(id: string) {
  if (!id || id.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(id)) throw new MediaError(400, 'Invalid photo identifier');
  const relative = Buffer.from(id, 'base64url').toString('utf8');
  if (encodeId(relative) !== id || relative.includes('\\') || /[\x00-\x1f\x7f]/.test(relative) || relative.split('/').some((part) => !part || part.startsWith('.'))) {
    throw new MediaError(400, 'Invalid photo identifier');
  }
  if (!extensions.has(path.extname(relative).toLowerCase())) throw new MediaError(404, 'Photo not found');
  return relative;
}

export async function ensureRoot() {
  await mkdir(config.photoRoot, { recursive: true });
  const stat = await lstat(config.photoRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new MediaError(500, 'The photo root must be a real directory');
}

async function checkedDirectory(parts: string[]) {
  await ensureRoot();
  let current = config.photoRoot;
  for (const part of parts) {
    if (!part || part.startsWith('.') || /[\\/\x00-\x1f\x7f]/.test(part)) throw new MediaError(400, 'Invalid folder');
    current = path.join(current, part);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new MediaError(404, 'Folder not found');
  }
  return current;
}

function photoRevision(relative: string, stat: { size: number; mtimeMs: number; ctimeMs: number }) {
  return createHash('sha256').update(JSON.stringify([config.photoRoot, relative, stat.size, stat.mtimeMs, stat.ctimeMs])).digest('base64url').slice(0, 20);
}

export async function openPhoto(id: string): Promise<{ handle: FileHandle; relative: string; bytes: number; modifiedAt: Date; revision: string }> {
  const relative = decodeId(id);
  try {
    const parts = relative.split('/');
    await checkedDirectory(parts.slice(0, -1));
    const handle = await open(path.join(config.photoRoot, relative), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()) { await handle.close(); throw new MediaError(404, 'Photo not found'); }
    return { handle, relative, bytes: stat.size, modifiedAt: stat.mtime, revision: photoRevision(relative, stat) };
  } catch (error) {
    if (error instanceof MediaError) throw error;
    throw new MediaError(404, 'Photo not found');
  }
}

async function photoInfo(relative: string, members: Member[], dimensions = { width: 4, height: 3 }): Promise<Photo | null> {
  const stat = await lstat(path.join(config.photoRoot, relative));
  if (!stat.isFile() || stat.isSymbolicLink()) return null;
  // Listings never read original bytes: mounted/network libraries can be slow.
  // Immich supplies actual dimensions when enriching the visible gallery page.
  const revision = photoRevision(relative, stat);
  const folder = relative.includes('/') ? relative.split('/')[0] : '';
  return { id: encodeId(relative), revision, name: path.basename(relative), folder, owner: members.find((member) => member.folder === folder)?.name || folder || 'Shared folder', width: dimensions.width, height: dimensions.height, bytes: stat.size, modifiedAt: stat.mtime.toISOString(), previewStatus: 'pending' };
}

export function invalidatePhotos() { const state = scanState(); state.generation++; if (state.cache) state.cache.time = 0; }

export async function scanPhotos(members: Member[], allowStale = false): Promise<Photo[]> {
  const state = scanState();
  const attribute = (photos: Photo[]) => {
    const owners = new Map(members.flatMap(member => [member.folder, ...(member.folders || [])].map(folder => [folder.toLowerCase(), member] as const)));
    return photos.map(photo => {
      const originalFolder = decodeId(photo.id).split('/').length > 1 ? decodeId(photo.id).split('/')[0] : '';
      const member = owners.get(originalFolder.toLowerCase());
      return { ...photo, folder: member?.folder || originalFolder, owner: member?.name || originalFolder || 'Shared folder' };
    });
  };
  if (state.cache && state.cache.root === config.photoRoot && Date.now() - state.cache.time < 15_000) return attribute(state.cache.photos);
  if (state.scanning) {
    if (allowStale && state.cache?.root === config.photoRoot) return attribute(state.cache.photos);
    return attribute(await state.scanning);
  }
  const startedGeneration = state.generation;
  state.scanning = (async () => {
    await ensureRoot();
    const started = performance.now();
    const photos: Photo[] = [];
    type Work = { relative: string; depth: number; directory: boolean };
    await runConcurrentQueue<Work>([{ relative: '', depth: 0, directory: true }], 4, (work, enqueue) => scanRequests(async () => {
      if (work.directory) {
        if (work.depth > 12) return;
        const entries = await readdir(path.join(config.photoRoot, work.relative), { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
          const relative = work.relative ? `${work.relative}/${entry.name}` : entry.name;
          if (entry.isDirectory()) enqueue({ relative, depth: work.depth + 1, directory: true });
          else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) enqueue({ relative, depth: work.depth, directory: false });
        }
      } else {
        try {
          const photo = await photoInfo(work.relative, members);
          if (photo) {
            if (photos.length >= 20_000) throw new MediaError(413, 'This prototype supports up to 20,000 photos per shared folder');
            photos.push(photo);
          }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
    }));
    if (state.uploaded) {
      const known = new Map(photos.map(photo => [photo.id, photo]));
      for (const photo of state.uploaded.values()) known.set(photo.id, photo);
      photos.splice(0, photos.length, ...known.values());
      state.uploaded = undefined;
    }
    if (performance.now() - started > 3_000) console.warn('Gather: slow folder listing', { milliseconds: Math.round(performance.now() - started), photos: photos.length });
    photos.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.id.localeCompare(b.id));
    if (state.generation === startedGeneration) state.cache = { root: config.photoRoot, time: Date.now(), photos, ids: new Set(photos.map(photo => photo.id)) };
    return photos;
  })();
  const work = state.scanning;
  if (allowStale && state.cache?.root === config.photoRoot) {
    void work.then(() => { if (state.scanning === work) state.scanning = undefined; }, () => { if (state.scanning === work) state.scanning = undefined; });
    return attribute(state.cache.photos);
  }
  try { return attribute(await work); } finally { if (state.scanning === work) state.scanning = undefined; }
}

export function validateFilename(name: string) {
  if (!name || name.startsWith('.') || /[\\/\x00-\x1f\x7f]/.test(name) || Buffer.byteLength(name) > 200 || !extensions.has(path.extname(name).toLowerCase())) {
    throw new MediaError(400, 'Choose a JPEG, PNG, WebP, AVIF, GIF, TIFF, or HEIC photo with a valid filename');
  }
  return name;
}

const activeUploads = new Map<string, number>();
const committingContent = new Map<string, Promise<Photo>>();

export async function duplicatePhoto(checksum: string, size: number, signal?: AbortSignal): Promise<Photo | undefined> {
  const candidates = (await scanPhotos([])).filter(photo => photo.bytes === size);
  let found: Photo | undefined;
  await mapConcurrent(candidates, 2, async candidate => {
    if (found) return;
    try {
      const relative = decodeId(candidate.id);
      const info = await photoInfo(relative, []);
      if (!info || info.bytes !== size) return;
      let digest = readFileChecksum(relative, info.revision!);
      if (!digest) {
        const file = await openPhoto(candidate.id);
        const hash = createHash('sha256');
        const stream = file.handle.createReadStream({ signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
        try { for await (const chunk of stream) hash.update(chunk); }
        finally { stream.destroy(); await file.handle.close().catch(() => {}); }
        const after = await photoInfo(relative, []);
        if (!after || after.revision !== info.revision) return;
        digest = hash.digest('hex');
        writeFileChecksum(relative, info.revision!, digest);
      }
      if (digest === checksum) found = { ...info, duplicate: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof MediaError && error.status === 404)) throw error;
    }
  });
  return found;
}
let uploadCount = 0;

export async function saveUpload(member: Member, name: string, body: ReadableStream<Uint8Array> | null, signal?: AbortSignal): Promise<Photo> {
  validateFilename(name);
  if (!body) throw new MediaError(400, 'No file was provided');
  if ((activeUploads.get(member.id) || 0) >= 2 || uploadCount >= 8) throw new MediaError(429, 'Please wait for the current uploads to finish');
  activeUploads.set(member.id, (activeUploads.get(member.id) || 0) + 1);
  uploadCount++;
  let temporary: string | undefined;
  let remoteTemporary: string | undefined;
  let size = 0;
  const started = performance.now();
  let stage = 'receiving';
  const timings: Record<string, number> = {};
  let stageStarted = started;
  const nextStage = (next: string) => { const now = performance.now(); timings[stage] = Math.round(now - stageStarted); stage = next; stageStarted = now; };
  try {
    const folder = await checkedDirectory([member.folder]);
    const staging = path.join(config.dataRoot, 'incoming');
    await mkdir(staging, { recursive: true, mode: 0o700 });
    temporary = path.join(staging, `.gather-incoming-${randomUUID()}`);
    const checksum = createHash('sha256');
    const limiter = new Transform({ transform(chunk, _encoding, callback) {
      size += chunk.length;
      checksum.update(chunk);
      callback(size > config.maxUploadBytes ? new MediaError(413, `Each photo must be smaller than ${config.maxUploadBytes / 1024 / 1024} MB`) : null, chunk);
    } });
    await pipeline(Readable.fromWeb(body as import('node:stream/web').ReadableStream<Uint8Array>), limiter, createWriteStream(temporary, { flags: 'wx', mode: 0o640 }), { signal });
    if (!size) throw new MediaError(400, 'The file is empty');
    const digest = checksum.digest('hex');
    const contentKey = JSON.stringify([currentCollectionId(), config.photoRoot, digest]);
    const running = committingContent.get(contentKey);
    if (running) return { ...await running, duplicate: true };
    const commit = (async () => {
      nextStage('duplicateCheck');
      const existing = await duplicatePhoto(digest, size, signal);
      if (existing) return existing;
      nextStage('validation');
      let dimensions = { width: 4, height: 3 };
      try {
        const info = await sharp(temporary!, { limitInputPixels: 80_000_000 }).metadata();
        if (!formats.has(info.format || '') || !info.width || !info.height) throw new Error('Unsupported image');
        if (info.width * info.height > 80_000_000) throw new Error('Image too large');
        const rotate = info.orientation && info.orientation >= 5;
        dimensions = { width: rotate ? info.height : info.width, height: rotate ? info.width : info.height };
        // Fully decode to reject truncated files; this does not create a thumbnail.
        await validateImage(info.width * info.height, async () => {
          signal?.throwIfAborted();
          await sharp(temporary!, { limitInputPixels: 80_000_000, failOn: 'warning' }).stats();
        });
      } catch {
        throw new MediaError(415, 'This server could not validate the image. Try JPEG or PNG; HEIC support depends on the server decoder.');
      }
      signal?.throwIfAborted();
      nextStage('storage');
      await checkedDirectory([member.folder]);
      remoteTemporary = path.join(folder, `.gather-incoming-${randomUUID()}`);
      await pipeline(createReadStream(temporary!), createWriteStream(remoteTemporary, { flags: 'wx', mode: 0o640 }), { signal });
      let saved = '';
      for (let attempt = 0; attempt < 5; attempt++) {
        const extension = path.extname(name);
        const candidate = attempt === 0 ? name : `${name.slice(0, -extension.length)}-${randomUUID().slice(0, 8)}${extension}`;
        try { await link(remoteTemporary, path.join(folder, candidate)); saved = candidate; break; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      }
      if (!saved) throw new MediaError(409, 'Could not choose a unique filename. Please retry.');
      await unlink(remoteTemporary); remoteTemporary = undefined;
      const photo = await photoInfo(`${member.folder}/${saved}`, [member], dimensions);
      if (!photo) throw new MediaError(500, 'Photo saved but could not be inspected');
      const state = scanState();
      // Merge commits into an ongoing listing so its older snapshot cannot lose uploads.
      if (state.scanning) (state.uploaded ||= new Map()).set(photo.id, photo);
      const scanCache = state.cache;
      if (scanCache?.root === config.photoRoot) {
        scanCache.photos = [...scanCache.photos.filter(existing => existing.id !== photo.id), photo];
        scanCache.ids.add(photo.id);
      }
      writeFileChecksum(`${member.folder}/${saved}`, photo.revision!, digest);
      nextStage('cleanup');
      return photo;
    })();
    committingContent.set(contentKey, commit);
    try { return await commit; }
    finally { if (committingContent.get(contentKey) === commit) committingContent.delete(contentKey); }
  } finally {
    if (remoteTemporary) await unlink(remoteTemporary).catch(() => {});
    if (temporary) await unlink(temporary).catch(() => {});
    const count = (activeUploads.get(member.id) || 1) - 1;
    if (count) activeUploads.set(member.id, count); else activeUploads.delete(member.id);
    uploadCount--;
    nextStage('done');
    if (performance.now() - started > 3_000) console.warn('Gather: slow upload', { milliseconds: Math.round(performance.now() - started), bytes: size, phases: timings });
  }
}

export function contentDisposition(filename: string) {
  const ascii = filename.replace(/[^a-zA-Z0-9_. -]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}


/** Previews only need an authorized path from the recent directory snapshot. */
export async function previewPath(id: string): Promise<string> {
  const relative = decodeId(id);
  const scanCache = scanState().cache;
  const ids = scanCache && scanCache.root === config.photoRoot && Date.now() - scanCache.time < 15_000
    ? scanCache.ids : new Set((await scanPhotos([])).map(photo => photo.id));
  if (!ids.has(id)) throw new MediaError(404, 'Photo not found');
  return relative;
}
