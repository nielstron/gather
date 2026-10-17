import { constants, createWriteStream } from 'node:fs';
import { mkdir, readdir, lstat, open, link, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import sharp from 'sharp';
import { config } from './config';
import { runConcurrentQueue } from '../async';
import type { Member, Photo } from '../types';

const extensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif', '.tif', '.tiff', '.heic', '.heif']);
const formats = new Set(['jpeg', 'png', 'webp', 'avif', 'gif', 'tiff', 'heif']);
let scanCache: { root: string; time: number; photos: Photo[]; ids: Set<string> } | undefined;
let scanning: Promise<Photo[]> | undefined;
let scanningRoot = '';
let generation = 0;

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

export async function openPhoto(id: string): Promise<{ handle: FileHandle; relative: string; bytes: number; modifiedAt: Date }> {
  const relative = decodeId(id);
  try {
    const parts = relative.split('/');
    await checkedDirectory(parts.slice(0, -1));
    const handle = await open(path.join(config.photoRoot, relative), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()) { await handle.close(); throw new MediaError(404, 'Photo not found'); }
    return { handle, relative, bytes: stat.size, modifiedAt: stat.mtime };
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
  const revision = createHash('sha256').update(JSON.stringify([config.photoRoot, relative, stat.size, stat.mtimeMs, stat.ctimeMs])).digest('base64url').slice(0, 20);
  const folder = relative.includes('/') ? relative.split('/')[0] : '';
  return { id: encodeId(relative), revision, name: path.basename(relative), folder, owner: members.find((member) => member.folder === folder)?.name || folder || 'Shared folder', width: dimensions.width, height: dimensions.height, bytes: stat.size, modifiedAt: stat.mtime.toISOString(), previewStatus: 'pending' };
}

export function invalidatePhotos() { generation++; scanCache = undefined; }

export async function scanPhotos(members: Member[]): Promise<Photo[]> {
  const attribute = (photos: Photo[]) => {
    const names = new Map(members.map(member => [member.folder, member.name]));
    return photos.map(photo => ({ ...photo, owner: names.get(photo.folder) || photo.folder || 'Shared folder' }));
  };
  if (scanCache && scanCache.root === config.photoRoot && Date.now() - scanCache.time < 15_000) return attribute(scanCache.photos);
  if (scanning && scanningRoot === config.photoRoot) return attribute(await scanning);
  scanningRoot = config.photoRoot;
  const startedGeneration = generation;
  scanning = (async () => {
    await ensureRoot();
    const photos: Photo[] = [];
    type Work = { relative: string; depth: number; directory: boolean };
    await runConcurrentQueue<Work>([{ relative: '', depth: 0, directory: true }], 16, async (work, enqueue) => {
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
    });
    photos.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.id.localeCompare(b.id));
    if (generation === startedGeneration) scanCache = { root: config.photoRoot, time: Date.now(), photos, ids: new Set(photos.map(photo => photo.id)) };
    return photos;
  })();
  const work = scanning;
  try { return attribute(await work); } finally { if (scanning === work) scanning = undefined; }
}

export function validateFilename(name: string) {
  if (!name || name.startsWith('.') || /[\\/\x00-\x1f\x7f]/.test(name) || Buffer.byteLength(name) > 200 || !extensions.has(path.extname(name).toLowerCase())) {
    throw new MediaError(400, 'Choose a JPEG, PNG, WebP, AVIF, GIF, TIFF, or HEIC photo with a valid filename');
  }
  return name;
}

const activeUploads = new Map<string, number>();
let uploadCount = 0;

export async function saveUpload(member: Member, name: string, body: ReadableStream<Uint8Array> | null, signal?: AbortSignal): Promise<Photo> {
  validateFilename(name);
  if (!body) throw new MediaError(400, 'No file was provided');
  if ((activeUploads.get(member.id) || 0) >= 2 || uploadCount >= 8) throw new MediaError(429, 'Please wait for the current uploads to finish');
  activeUploads.set(member.id, (activeUploads.get(member.id) || 0) + 1);
  uploadCount++;
  let temporary: string | undefined;
  let size = 0;
  try {
    const folder = await checkedDirectory([member.folder]);
    temporary = path.join(folder, `.gather-incoming-${randomUUID()}`);
    const limiter = new Transform({ transform(chunk, _encoding, callback) {
      size += chunk.length;
      callback(size > config.maxUploadBytes ? new MediaError(413, `Each photo must be smaller than ${config.maxUploadBytes / 1024 / 1024} MB`) : null, chunk);
    } });
    await pipeline(Readable.fromWeb(body as import('node:stream/web').ReadableStream<Uint8Array>), limiter, createWriteStream(temporary, { flags: 'wx', mode: 0o640 }), { signal });
    if (!size) throw new MediaError(400, 'The file is empty');
    let dimensions = { width: 4, height: 3 };
    try {
      const info = await sharp(temporary, { limitInputPixels: 80_000_000 }).metadata();
      if (!formats.has(info.format || '') || !info.width || !info.height) throw new Error('Unsupported image');
      if (info.width * info.height > 80_000_000) throw new Error('Image too large');
      const rotate = info.orientation && info.orientation >= 5;
      dimensions = { width: rotate ? info.height : info.width, height: rotate ? info.width : info.height };
      // Fully decode to reject truncated files; this does not create a thumbnail.
      await sharp(temporary, { limitInputPixels: 80_000_000, failOn: 'warning' }).stats();
    } catch {
      throw new MediaError(415, 'This server could not validate the image. Try JPEG or PNG; HEIC support depends on the server decoder.');
    }
    await checkedDirectory([member.folder]);
    let saved = '';
    for (let attempt = 0; attempt < 5; attempt++) {
      const extension = path.extname(name);
      const candidate = attempt === 0 ? name : `${name.slice(0, -extension.length)}-${randomUUID().slice(0, 8)}${extension}`;
      try { await link(temporary, path.join(folder, candidate)); saved = candidate; break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    if (!saved) throw new MediaError(409, 'Could not choose a unique filename. Please retry.');
    invalidatePhotos();
    const photo = await photoInfo(`${member.folder}/${saved}`, [member], dimensions);
    if (!photo) throw new MediaError(500, 'Photo saved but could not be inspected');
    return photo;
  } finally {
    if (temporary) await unlink(temporary).catch(() => {});
    const count = (activeUploads.get(member.id) || 1) - 1;
    if (count) activeUploads.set(member.id, count); else activeUploads.delete(member.id);
    uploadCount--;
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
  const ids = scanCache && scanCache.root === config.photoRoot && Date.now() - scanCache.time < 15_000
    ? scanCache.ids : new Set((await scanPhotos([])).map(photo => photo.id));
  if (!ids.has(id)) throw new MediaError(404, 'Photo not found');
  return relative;
}
