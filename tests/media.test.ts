import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import sharp from 'sharp';
import type { Member } from '../src/lib/types';

const directory = mkdtempSync(path.join(os.tmpdir(), 'gather-media-'));
const photoRoot = path.join(directory, 'photos');
process.env.PHOTO_ROOT = photoRoot;
process.env.DATA_ROOT = path.join(directory, 'data');
process.env.MAX_UPLOAD_MB = '1';
process.env.ORIGIN = 'http://localhost:5173';
const media = await import('../src/lib/server/media');
const alice: Member = { id: 'alice-id', name: 'Alice', folder: 'alice' };
const bob: Member = { id: 'bob-id', name: 'Bob', folder: 'bob' };
mkdirSync(path.join(photoRoot, 'alice'), { recursive: true });
mkdirSync(path.join(photoRoot, 'bob'), { recursive: true });
const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: 'red' } }).png().toBuffer();
const bluePng = await sharp({ create: { width: 20, height: 20, channels: 3, background: 'blue' } }).png().toBuffer();
after(() => rmSync(directory, { recursive: true, force: true }));

function body(bytes: Uint8Array) {
  return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
}

function hasStatus(status: number) {
  return (error: unknown) => error instanceof media.MediaError && error.status === status;
}

async function assertNoTemporaryFiles(folder = 'alice') {
  assert.equal((await readdir(path.join(photoRoot, folder))).some((name) => name.startsWith('.gather-incoming-')), false);
}

test('uploads preserve original bytes, use the member folder, and never overwrite duplicate names', async () => {
  const first = await media.saveUpload(alice, 'holiday.png', body(png));
  const duplicate = await media.saveUpload(alice, 'holiday.png', body(bluePng));
  assert.equal(first.folder, 'alice');
  assert.equal(first.owner, 'Alice');
  assert.equal(first.width, 20);
  assert.notEqual(first.name, duplicate.name);
  assert.deepEqual(await readFile(path.join(photoRoot, 'alice', first.name)), png);
  assert.deepEqual(await readFile(path.join(photoRoot, 'alice', duplicate.name)), bluePng);
  assert.deepEqual(await readdir(path.join(photoRoot, 'bob')), []);
  const opened = await media.openPhoto(first.id);
  try { assert.deepEqual(await opened.handle.readFile(), png); }
  finally { await opened.handle.close(); }
  await assertNoTemporaryFiles();
});

test('upload limits apply while streaming and clean up partial files', async () => {
  let chunk = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(Buffer.alloc(64 * 1024));
      if (++chunk === 20) controller.close();
    },
    cancel() { cancelled = true; }
  }, { highWaterMark: 0 });
  await assert.rejects(media.saveUpload(alice, 'too-large.png', stream), hasStatus(413));
  assert.equal(cancelled, true);
  assert.equal((await readdir(path.join(photoRoot, 'alice'))).includes('too-large.png'), false);
  await assertNoTemporaryFiles();
  await assert.rejects(media.saveUpload(alice, 'empty.png', body(Buffer.alloc(0))), hasStatus(400));
  await assert.rejects(media.saveUpload(alice, 'missing.png', null), hasStatus(400));
  await assertNoTemporaryFiles();
});

test('failed and aborted request streams remove temporary uploads', async () => {
  const broken = new ReadableStream<Uint8Array>({
    pull(controller) { controller.error(new Error('Upload disconnected')); }
  });
  await assert.rejects(media.saveUpload(alice, 'broken.png', broken), /Upload disconnected/);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(media.saveUpload(alice, 'aborted.png', body(png), abort.signal), /abort/i);
  await assertNoTemporaryFiles();
});

test('malformed and truncated images are rejected before they enter the collection', async () => {
  await assert.rejects(media.saveUpload(alice, 'not-a-photo.jpg', body(Buffer.from('<html>hello</html>'))), hasStatus(415));
  // This has enough PNG header for metadata(), but its pixel data is incomplete.
  const corrupt = png.subarray(0, 70);
  assert.equal((await sharp(corrupt).metadata()).width, 20);
  await assert.rejects(media.saveUpload(alice, 'truncated.png', body(corrupt)), hasStatus(415));
  assert.equal((await readdir(path.join(photoRoot, 'alice'))).includes('truncated.png'), false);
  await assertNoTemporaryFiles();
});

test('simultaneous requests cannot bypass the per-member upload cap', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let thirdStarted!: () => void;
  const thirdReading = new Promise<'admitted'>((resolve) => { thirdStarted = () => resolve('admitted'); });
  const uploads = Array.from({ length: 3 }, (_, index) => {
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (index === 2) thirdStarted();
        await gate;
        controller.enqueue(png);
        controller.close();
      }
    }, { highWaterMark: 0 });
    return media.saveUpload(alice, `concurrent-${index}.png`, stream)
      .then((photo) => ({ photo, error: null }), (error: unknown) => ({ photo: null, error }));
  });
  const thirdResult = await Promise.race([uploads[2].then(() => 'rejected'), thirdReading]);
  release();
  const results = await Promise.all(uploads);
  assert.equal(thirdResult, 'rejected');
  assert.equal(results.filter((result) => result.photo).length, 2);
  assert.ok(hasStatus(429)(results[2].error));
  await assertNoTemporaryFiles();
});

test('paths, identifiers, and symlinks cannot escape the shared photo root', async () => {
  for (const filename of ['../bob/stolen.png', '/tmp/file.png', 'bob/file.png', 'bob\\file.png', '.hidden.png', 'bad\nname.png', 'photo.svg']) {
    assert.throws(() => media.validateFilename(filename), hasStatus(400));
  }
  for (const relative of ['../secret.png', '/secret.png', 'alice/../secret.png', 'alice//photo.png', 'alice/./photo.png', 'alice\\photo.png']) {
    assert.throws(() => media.decodeId(media.encodeId(relative)), hasStatus(400));
  }
  assert.throws(() => media.decodeId('%%%'), hasStatus(400));
  assert.throws(() => media.decodeId(Buffer.from([0xff]).toString('base64url')), hasStatus(400));
  await assert.rejects(media.saveUpload({ ...alice, folder: '../bob' }, 'escape.png', body(png)), hasStatus(400));
  const outside = path.join(directory, 'outside');
  mkdirSync(outside);
  writeFileSync(path.join(outside, 'secret.png'), bluePng);
  symlinkSync(outside, path.join(photoRoot, 'shortcut'));
  symlinkSync(path.join(outside, 'secret.png'), path.join(photoRoot, 'alice', 'shortcut.png'));
  await assert.rejects(media.openPhoto(media.encodeId('shortcut/secret.png')), hasStatus(404));
  await assert.rejects(media.openPhoto(media.encodeId('alice/shortcut.png')), hasStatus(404));
  await assert.rejects(media.saveUpload({ ...alice, folder: 'shortcut' }, 'escape.png', body(png)), hasStatus(404));
  media.invalidatePhotos();
  const photos = await media.scanPhotos([alice, bob]);
  assert.ok(photos.length > 0);
  assert.equal(photos.some((photo) => photo.name === 'secret.png' || photo.name === 'shortcut.png'), false);
  assert.deepEqual(await readFile(path.join(outside, 'secret.png')), bluePng);
});

test('download selection validates identifiers and streams a complete ZIP with originals', async () => {
  const download = await import('../src/routes/api/download/+server');
  const first = media.encodeId('alice/holiday.png');
  const requestFor = (ids: unknown) => ({ request: new Request('http://localhost:5173/api/download', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids })
  }) });
  const invalid = await download.POST(requestFor([first, media.encodeId('../secret.png')]) as never);
  assert.equal(invalid.status, 400);
  const missing = await download.POST(requestFor([first, media.encodeId('alice/missing.png')]) as never);
  assert.equal(missing.status, 404);
  const oversized = await download.POST(requestFor(Array(201).fill(first)) as never);
  assert.equal(oversized.status, 400);
  const response = await download.POST(requestFor([first, first]) as never);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/zip');
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.subarray(0, 4).toString('hex'), '504b0304');
  assert.equal(bytes.subarray(-22, -18).toString('hex'), '504b0506');
  assert.equal(bytes.readUInt16LE(bytes.length - 12), 1);
  assert.ok(bytes.includes(Buffer.from('alice/holiday.png')));
  assert.ok(bytes.includes(png));
});

test('API hooks guard private endpoints and require a trusted Origin for sign-in', async () => {
  const { handle } = await import('../src/hooks.server');
  async function request(pathname: string, method = 'GET', origin?: string, host = 'http://localhost:5173', route?: string) {
    const url = new URL(pathname, host);
    const event = {
      url, request: new Request(url, { method, headers: origin ? { origin } : {} }),
      cookies: { get: () => undefined }, locals: {}, route: route ? { id: route } : undefined
    };
    return handle({ event, resolve: async () => new Response('resolved', { headers: { 'content-type': 'text/html' } }) } as never);
  }
  for (const pathname of ['/api/photos', '/api/media/id', '/api/upload', '/api/download', '/api/logout', '/api/profile']) {
    const response = await request(pathname);
    assert.equal(response.status, 401, pathname);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
  }
  assert.equal((await request('/custom-prefix/api/photos', 'GET', undefined, undefined, '/api/photos')).status, 401);
  assert.equal((await request('/custom-prefix/api/admin/config', 'GET', undefined, undefined, '/api/admin/config')).status, 401);
  assert.equal((await request('/api/session', 'POST')).status, 403);
  assert.equal((await request('/api/session', 'POST', 'https://attacker.example')).status, 403);
  assert.equal((await request('/api/session', 'POST', 'http://localhost:5173')).status, 200);
  assert.equal((await request('/api/join', 'POST')).status, 403);
  assert.equal((await request('/api/join', 'POST', 'https://attacker.example')).status, 403);
  assert.equal((await request('/api/join', 'POST', 'http://localhost:5173')).status, 200);
  const page = await request('/');
  assert.equal(page.headers.get('cache-control'), 'private, no-store');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  const originalMode = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    assert.equal((await request('/api/session', 'POST', 'https://attacker.example', 'https://attacker.example')).status, 403);
  } finally {
    if (originalMode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalMode;
  }
});


test('photo caches remain isolated when requests use different collection snapshots', async () => {
  const { readSettings, writeSettings, withSettings } = await import('../src/lib/server/settings');
  const original = readSettings();
  const anotherRoot = path.join(directory, 'another-collection');
  mkdirSync(anotherRoot, { recursive: true });
  writeFileSync(path.join(anotherRoot, 'different.png'), png);
  await withSettings(async () => {
    await media.scanPhotos([]);
    writeSettings({ ...original, photoRoot: anotherRoot });
    const photos = await media.scanPhotos([]);
    assert.deepEqual(photos.map(photo => photo.name), ['different.png']);
  });
  writeSettings(original);
  const restored = await media.scanPhotos([]);
  assert.ok(restored.every(photo => photo.name !== 'different.png'));
});


test('gallery discovery does not inspect original image bytes before returning files', async (t) => {
  const filename = path.join(photoRoot, 'alice', 'cold-network-photo.png');
  writeFileSync(filename, png);
  const metadata = t.mock.method(sharp.prototype, 'metadata', () => {
    throw new Error('Gallery discovery must not open an image decoder');
  });
  try {
    media.invalidatePhotos();
    const photos = await media.scanPhotos([alice]);
    const discovered = photos.find(photo => photo.name === 'cold-network-photo.png');
    assert.ok(discovered);
    assert.equal(discovered.bytes, png.length);
    assert.equal(metadata.mock.callCount(), 0);
  } finally {
    metadata.mock.restore();
    rmSync(filename);
    media.invalidatePhotos();
  }
});


test('preview snapshots reject hidden and symlink paths and track file revisions', async () => {
  media.invalidatePhotos();
  const before = await media.scanPhotos([alice]);
  const photo = before.find(photo => photo.name === 'holiday.png')!;
  assert.ok(photo.revision);
  assert.equal(await media.previewPath(photo.id), 'alice/holiday.png');
  await assert.rejects(media.previewPath(media.encodeId('shortcut/secret.png')), hasStatus(404));
  await assert.rejects(media.previewPath(media.encodeId('alice/shortcut.png')), hasStatus(404));
  await assert.rejects(media.previewPath(media.encodeId('.hidden.png')), hasStatus(400));
  const renamed: Member = { ...alice, name: 'New name' };
  await media.scanPhotos([]);
  const again = await media.scanPhotos([renamed]);
  assert.equal(again.find(entry => entry.id === photo.id)?.owner, 'New name');
});

test('authenticated previews retain private caching while originals and rejected requests stay uncached', async () => {
  const auth = await import('../src/lib/server/auth');
  const { handle } = await import('../src/hooks.server');
  const invitation = auth.createMember('Cache visitor', 'cache-visitor');
  const session = auth.exchangeInvite(invitation.token)!;
  async function request(contentType: string, authenticated: boolean) {
    const url = new URL('http://localhost:5173/api/media/photo');
    return handle({ event: {
      url, route: { id: '/api/media/[id]' }, request: new Request(url),
      cookies: { get: (name: string) => name === 'gather_session' && authenticated ? session.sessionToken : undefined }, locals: {}
    }, resolve: async () => new Response('bytes', { headers: { 'content-type': contentType, 'cache-control': 'private, max-age=60' } }) } as never);
  }
  assert.equal((await request('image/webp', true)).headers.get('cache-control'), 'private, max-age=60');
  assert.equal((await request('application/octet-stream', true)).headers.get('cache-control'), 'private, no-store');
  const denied = await request('image/webp', false);
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get('cache-control'), 'private, no-store');
});
