import { constants, createWriteStream } from 'node:fs';
import { mkdir, readdir, lstat, open, link, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import sharp from 'sharp';
import { config } from './config';
import type { Member, Photo } from '../types';

const extensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif', '.tif', '.tiff', '.heic', '.heif']);
const formats = new Set(['jpeg', 'png', 'webp', 'avif', 'gif', 'tiff', 'heif']);
const metadata = new Map<string, { version: string; width: number; height: number }>();
let scanCache: { root: string; time: number; photos: Photo[] } | undefined;
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

async function photoInfo(relative: string, members: Member[]): Promise<Photo | null> {
  const absolute = path.join(config.photoRoot, relative);
  const stat = await lstat(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) return null;
  const version = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  let dimensions = metadata.get(absolute);
  if (!dimensions || dimensions.version !== version) {
    try {
      // Metadata inspection only. All visible thumbnails and previews come from Immich.
      const result = await sharp(absolute, { limitInputPixels: 80_000_000 }).metadata();
      if (!formats.has(result.format || '') || !result.width || !result.height) return null;
      const rotate = result.orientation && result.orientation >= 5;
      dimensions = { version, width: rotate ? result.height : result.width, height: rotate ? result.width : result.height };
    } catch {
      // Some libvips builds cannot inspect HEIC. Immich can still preview it once indexed.
      if (!['.heic', '.heif'].includes(path.extname(relative).toLowerCase())) return null;
      dimensions = { version, width: 4, height: 3 };
    }
    if (metadata.size >= 20_000) metadata.clear();
    metadata.set(absolute, dimensions);
  }
  const folder = relative.includes('/') ? relative.split('/')[0] : '';
  return { id: encodeId(relative), name: path.basename(relative), folder, owner: members.find((member) => member.folder === folder)?.name || folder || 'Shared folder', width: dimensions.width, height: dimensions.height, bytes: stat.size, modifiedAt: stat.mtime.toISOString(), previewStatus: 'pending' };
}

export function invalidatePhotos() { generation++; scanCache = undefined; }

export async function scanPhotos(members: Member[]): Promise<Photo[]> {
  if (scanCache && scanCache.root === config.photoRoot && Date.now() - scanCache.time < 15_000) return scanCache.photos;
  if (scanning && scanningRoot === config.photoRoot) return scanning;
  scanningRoot = config.photoRoot;
  const startedGeneration = generation;
  scanning = (async () => {
    await ensureRoot();
    const photos: Photo[] = [];
    async function walk(directory: string, depth: number) {
      if (depth > 12) return;
      const entries = await readdir(path.join(config.photoRoot, directory), { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
        const relative = directory ? `${directory}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(relative, depth + 1);
        else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) {
          if (photos.length >= 20_000) throw new MediaError(413, 'This prototype supports up to 20,000 photos per shared folder');
          try { const photo = await photoInfo(relative, members); if (photo) photos.push(photo); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
      }
    }
    await walk('', 0);
    photos.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.id.localeCompare(b.id));
    if (generation === startedGeneration) scanCache = { root: config.photoRoot, time: Date.now(), photos };
    return photos;
  })();
  const work = scanning;
  try { return await work; } finally { if (scanning === work) scanning = undefined; }
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
    try {
      const info = await sharp(temporary, { limitInputPixels: 80_000_000 }).metadata();
      if (!formats.has(info.format || '') || !info.width || !info.height) throw new Error('Unsupported image');
      if (info.width * info.height > 80_000_000) throw new Error('Image too large');
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
    const photo = await photoInfo(`${member.folder}/${saved}`, [member]);
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
