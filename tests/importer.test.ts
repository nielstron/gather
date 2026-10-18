import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';

const directory = mkdtempSync(path.join(os.tmpdir(), 'gather-import-'));
process.env.PHOTO_ROOT = path.join(directory, 'photos'); process.env.DATA_ROOT = path.join(directory, 'data');
mkdirSync(process.env.PHOTO_ROOT);
const settings = await import('../src/lib/server/settings');
const auth = await import('../src/lib/server/auth');
const { createImporter } = await import('../src/lib/server/importer');
const { MediaError } = await import('../src/lib/server/media');
const buffers = await Promise.all(['#557799', '#995577'].map(background => sharp({ create: { width: 12, height: 10, channels: 3, background } }).png().toBuffer()));
after(() => rmSync(directory, { recursive: true, force: true }));
const source = (id: string) => ({ id, url: `https://lh3.googleusercontent.com/pw/${id}`, modified: 1 });
const album = { url: 'https://photos.google.com/share/AF1Qabcdefghijklmnopqrstuv?key=abcdefghijklmnopqrstuv', title: 'Our trip', unsupported: 0, photos: [source('first'), source('second')] };
const image = (index: number) => new Response(new Uint8Array(buffers[index]), { headers: { 'content-type': 'image/png', 'content-length': String(buffers[index].length), 'content-disposition': `attachment; filename="photo-${index}.png"` } });
async function isolated(work: (member: import('../src/lib/types').Member) => Promise<void>) {
  const root = path.join(directory, `collection-${Math.random().toString(36).slice(2)}`); mkdirSync(root);
  const id = settings.createCollection({ ...settings.readSettings(), photoRoot: root, immichUrl: '', immichApiKey: '', immichScanApiKey: '' });
  await settings.withSettings(async () => { await work(auth.createMember('Visitor', 'Visitor').member); }, id);
}

test('previews require explicit start; imports run concurrently and repeat imports skip before downloading', async () => isolated(async member => {
  let downloads = 0, concurrent = 0, peak = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => release = resolve);
  const service = createImporter({ discover: async () => album, scan: async () => {}, download: async photo => {
    downloads++; concurrent++; peak = Math.max(peak, concurrent);
    if (concurrent === 2) release(); await gate;
    concurrent--; return image(photo.id === 'first' ? 0 : 1);
  } });
  const preview = await service.preview(member, album.url);
  assert.equal(preview.total, 2); assert.equal(downloads, 0);
  assert.equal((await readdir(path.join(settings.readSettings().photoRoot, member.folder))).length, 0);
  const other = auth.createMember('Other visitor', 'Other').member;
  assert.throws(() => service.start(other, preview.id), /not found/);
  assert.throws(() => service.cancel(other, preview.id), /not found/);
  assert.deepEqual(service.list(other), []);
  service.start(member, preview.id); await service.settled(preview.id);
  const done = service.list(member)[0];
  assert.equal(done.status, 'done'); assert.equal(done.imported, 2); assert.equal(peak, 2);
  assert.equal(JSON.stringify(done).includes('googleusercontent'), false);
  assert.equal(JSON.stringify(done).includes('key='), false);
  const second = await service.preview(member, album.url);
  service.start(member, second.id); await service.settled(second.id);
  assert.equal(service.list(member).find(job => job.id === second.id)?.duplicates, 2);
  assert.equal(downloads, 2, 'Known sources must skip the media request entirely');
  // Source receipts do not skip photos that have since been removed locally.
  await unlink(path.join(settings.readSettings().photoRoot, member.folder, 'photo-0.png'));
  const third = await service.preview(member, album.url);
  service.start(member, third.id); await service.settled(third.id);
  const restored = service.list(member).find(job => job.id === third.id)!;
  assert.equal(restored.imported, 1); assert.equal(restored.duplicates, 1); assert.equal(downloads, 3);
  assert.equal(statSync(path.join(settings.collectionDataRoot(), 'imports.sqlite')).mode & 0o777, 0o600);
}));

test('cancels in-flight downloads, then retries remaining photos without losing the job', async () => isolated(async member => {
  let block = true, entered = 0;
  let ready!: () => void;
  const gate = new Promise<void>(resolve => ready = resolve);
  const service = createImporter({ discover: async () => album, scan: async () => {}, download: async (photo, signal) => {
    if (block) {
      if (++entered === 2) ready();
      await new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
    return image(photo.id === 'first' ? 0 : 1);
  } });
  const job = await service.preview(member, album.url);
  service.start(member, job.id); await gate;
  service.cancel(member, job.id);
  assert.throws(() => service.start(member, job.id), /Cancellation is finishing/);
  await service.settled(job.id);
  assert.equal(service.list(member)[0].status, 'cancelled');
  assert.equal(service.list(member)[0].imported, 0);
  block = false; service.start(member, job.id); await service.settled(job.id);
  assert.equal(service.list(member)[0].status, 'done'); assert.equal(service.list(member)[0].imported, 2);
}));

test('partial failures retry only failed photos, and temporary failures retry automatically', async () => isolated(async member => {
  let permanent = true, secondAttempts = 0; const calls = new Map<string, number>();
  const service = createImporter({ discover: async () => album, scan: async () => {}, download: async photo => {
    calls.set(photo.id, (calls.get(photo.id) || 0) + 1);
    if (photo.id === 'second') {
      if (permanent) throw new MediaError(415, 'This download is not a supported photo.');
      if (++secondAttempts === 1) throw new MediaError(503, 'Please retry.');
    }
    return image(photo.id === 'first' ? 0 : 1);
  } });
  const job = await service.preview(member, album.url); service.start(member, job.id); await service.settled(job.id);
  assert.equal(service.list(member)[0].status, 'partial'); assert.equal(service.list(member)[0].failed, 1);
  permanent = false; service.start(member, job.id); await service.settled(job.id);
  assert.equal(service.list(member)[0].status, 'done'); assert.equal(service.list(member)[0].imported, 2);
  assert.equal(calls.get('first'), 1); assert.equal(calls.get('second'), 3);
}));

test('queued jobs resume after recreating the worker and are isolated from another collection', async () => isolated(async member => {
  const service = createImporter({ discover: async () => album, scan: async () => {}, download: async photo => image(photo.id === 'first' ? 0 : 1) });
  const preview = await service.preview(member, album.url);
  // Simulate an interrupted process with persisted work but no surviving worker.
  const Database = (await import('better-sqlite3')).default;
  const connection = new Database(path.join(settings.collectionDataRoot(), 'imports.sqlite'));
  const row = connection.prepare('SELECT data FROM jobs WHERE id=?').get(preview.id) as { data: string };
  const queued = { ...JSON.parse(row.data), status: 'queued' };
  connection.prepare('UPDATE jobs SET status=?,data=? WHERE id=?').run('queued', JSON.stringify(queued), preview.id); connection.close();
  const restarted = createImporter({ scan: async () => {}, download: async photo => image(photo.id === 'first' ? 0 : 1) });
  restarted.list(member); await restarted.settled(preview.id);
  assert.equal(restarted.list(member)[0].status, 'done');
  await settings.withSettings(async () => {
    assert.deepEqual(restarted.list(member), []);
    assert.throws(() => restarted.start(member, preview.id), /not found/);
  }, 'default');
}));

test('album inspection rejects videos-only albums before creating any import job', async () => isolated(async member => {
  const service = createImporter({ discover: async () => ({ ...album, photos: [], unsupported: 3 }) });
  await assert.rejects(service.preview(member, album.url), /only videos/);
  assert.deepEqual(service.list(member), []);
}));
