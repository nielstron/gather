import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, readdir, lstat, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { config } from './config';
import { uploadScope, readUploadReceipt, writeUploadReceipt } from './auth';
import { saveUpload, validateFilename, MediaError } from './media';
import { requestLibraryScan } from './immich';
import type { Member, Photo } from '../types';

export const chunkSize = 1024 * 1024;
type Metadata = { name: string; size: number; type: string; checksum: string; ownerScope: string };
const locks = new Set<string>();
const pending = new Map<string, { promise: Promise<Photo>; controller: AbortController }>();
const lifetime = 24 * 3600_000;
const diskBudget = 4 * 1024 * 1024 * 1024;
let sweptAt = 0;
function location(member: Member, id: string) {
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(id)) throw new MediaError(400, 'Invalid upload identifier.');
  const scope = uploadScope(member, id);
  const directory = path.join(config.dataRoot, 'resumable');
  return { scope, directory, metadata: path.join(directory, `${scope}.json`), part: path.join(directory, `${scope}.part`) };
}
async function erase(files: ReturnType<typeof location>) {
  await Promise.all([files.part, files.metadata].map(file => unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; })));
}
async function sweep(directory: string) {
  if (Date.now() - sweptAt < 300_000) return;
  sweptAt = Date.now();
  for (const name of await readdir(directory)) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const scope = name.slice(0, -5);
    if (pending.has(scope) || locks.has(scope)) continue;
    const filename = path.join(directory, name);
    const stat = await lstat(filename).catch(() => null);
    if (stat && Date.now() - stat.mtimeMs > lifetime) {
      await Promise.all([filename, path.join(directory, `${scope}.part`)].map(file => unlink(file).catch(() => {})));
    }
  }
}
async function exclusive<T>(scope: string, task: () => Promise<T>) {
  if (locks.has(scope)) throw new MediaError(409, 'Upload is busy. Please retry.');
  locks.add(scope);
  try { return await task(); } finally { locks.delete(scope); }
}
async function metadata(files: ReturnType<typeof location>): Promise<Metadata> {
  try { return JSON.parse(await readFile(files.metadata, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new MediaError(404, 'Start this upload again.'); throw error; }
}
async function offset(files: ReturnType<typeof location>) { return (await lstat(files.part).catch(error => { if (error.code !== 'ENOENT') throw error; return null; }))?.size || 0; }
const fingerprint = (meta: Metadata) => JSON.stringify([meta.name, meta.type, meta.size, meta.checksum]);

export async function startUpload(member: Member, id: string, input: unknown) {
  const meta = input as Metadata;
  if (!meta || typeof meta.name !== 'string' || !Number.isSafeInteger(meta.size) || meta.size <= 0 || meta.size > config.maxUploadBytes || typeof meta.type !== 'string' || meta.type.length > 200 || typeof meta.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(meta.checksum)) throw new MediaError(400, 'Invalid upload details.');
  validateFilename(meta.name);
  if (meta.ownerScope !== uploadScope(member, 'browser-queue')) throw new MediaError(409, 'This collection has changed. Select the photos again.');
  const files = location(member, id);
  return exclusive(files.scope, async () => {
    const photo = readUploadReceipt(files.scope, fingerprint(meta));
    if (photo) return { offset: meta.size, photo };
    await mkdir(files.directory, { recursive: true, mode: 0o700 });
    await sweep(files.directory);
    const existing = await readFile(files.metadata, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return ''; });
    if (existing) {
      if (fingerprint(JSON.parse(existing)) !== fingerprint(meta)) throw new MediaError(409, 'This upload identifier belongs to a different file.');
    } else {
      if ((await readdir(files.directory)).filter(name => name.endsWith('.json')).length >= 512) throw new MediaError(507, 'The upload buffer is full. Please retry later.');
      await writeFile(files.metadata, JSON.stringify(meta), { flag: 'wx', mode: 0o600 });
    }
    return { offset: await offset(files), processing: pending.has(files.scope) };
  });
}
export async function appendUpload(member: Member, id: string, position: number, bytes: Uint8Array) {
  const files = location(member, id);
  return exclusive(files.scope, async () => {
    const meta = await metadata(files);
    if (pending.has(files.scope)) throw new MediaError(409, 'This photo is already being saved.');
    const current = await offset(files);
    if (!Number.isSafeInteger(position) || position !== current) throw new MediaError(409, 'Upload position changed. Resume this upload.');
    if (!bytes.length || bytes.length > chunkSize || current + bytes.length > meta.size) throw new MediaError(400, 'Invalid upload chunk.');
    let used = 0;
    for (const name of await readdir(files.directory)) if (name.endsWith('.part')) used += (await lstat(path.join(files.directory, name)).catch(() => null))?.size || 0;
    if (used + bytes.length > diskBudget) throw new MediaError(507, 'The upload buffer is full. Please retry later.');
    const handle = await open(files.part, 'a', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } catch (error) { await handle.truncate(current).catch(() => {}); throw error; }
    finally { await handle.close(); }
    return { offset: current + bytes.length };
  });
}
export async function finishUpload(member: Member, id: string) {
  const files = location(member, id);
  const work = await exclusive(files.scope, async () => {
    const running = pending.get(files.scope);
    if (running) return running;
    const meta = await metadata(files);
    const known = readUploadReceipt(files.scope, fingerprint(meta));
    if (known) return { promise: Promise.resolve(known), controller: new AbortController() };
    if (await offset(files) !== meta.size) throw new MediaError(409, 'The photo has not finished transferring.');
    const controller = new AbortController();
    // The server owns the complete file now. A hidden/closed tab cannot cancel saving it.
    const promise = (async () => {
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(files.part, { signal: controller.signal })) hash.update(chunk);
      if (hash.digest('hex') !== meta.checksum) { await erase(files); throw new MediaError(400, 'The photo checksum did not match. Select it again.'); }
      const stream = Readable.toWeb(createReadStream(files.part)) as ReadableStream<Uint8Array>;
      const photo = await saveUpload(member, meta.name, stream, controller.signal);
      writeUploadReceipt(files.scope, fingerprint(meta), photo);
      if (!photo.duplicate) void requestLibraryScan().catch(() => {});
      // Keep the small receipt until expiry so a lost completion response can be retried.
      await unlink(files.part).catch(() => {});
      return photo;
    })().finally(() => pending.delete(files.scope));
    const result = { promise, controller }; pending.set(files.scope, result);
    return result;
  });
  return work.promise;
}
export async function cancelResumableUpload(member: Member, id: string) {
  const files = location(member, id);
  const running = pending.get(files.scope);
  if (running) { running.controller.abort(); await running.promise.catch(() => {}); }
  return exclusive(files.scope, () => erase(files));
}
