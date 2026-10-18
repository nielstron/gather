import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { readFile, readdir, writeFile, truncate, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import sharp from 'sharp';
const directory = mkdtempSync(path.join(os.tmpdir(), 'gather-resumable-test-'));
process.env.PHOTO_ROOT = path.join(directory, 'photos');
process.env.DATA_ROOT = path.join(directory, 'data');
for (const folder of ['alice', 'bob']) mkdirSync(path.join(directory, 'photos', folder), { recursive: true });
const { startUpload, appendUpload, finishUpload, cancelResumableUpload, chunkSize } = await import('../src/lib/server/resumable-upload');
const { uploadScope } = await import('../src/lib/server/auth');
const alice = { id: 'alice', name: 'Alice', folder: 'alice' }, bob = { id: 'bob', name: 'Bob', folder: 'bob' };
const image = await sharp(randomBytes(1024 * 1024 * 3), { raw: { width: 1024, height: 1024, channels: 3 } }).png().toBuffer();
const details = { name: 'resumed-photo.png', size: image.length, type: 'image/png', checksum: createHash('sha256').update(image).digest('hex'), ownerScope: uploadScope(alice, 'browser-queue') };
after(() => rmSync(directory, { recursive: true, force: true }));
const status = (expected: number) => (error: any) => error.status === expected;

test('resuming reads the durable byte offset, rejects repeated chunks, and saves exactly once', async () => {
  const id = 'resumable-upload-identifier';
  assert.equal((await startUpload(alice, id, details)).offset, 0);
  await appendUpload(alice, id, 0, image.subarray(0, chunkSize));
  assert.equal((await startUpload(alice, id, details)).offset, chunkSize);
  await assert.rejects(appendUpload(alice, id, 0, image.subarray(0, chunkSize)), status(409));
  await assert.rejects(finishUpload(alice, id), status(409));
  await assert.rejects(appendUpload(alice, id, chunkSize, image.subarray(chunkSize)), status(400));
  for (let position = chunkSize; position < image.length; position += chunkSize) await appendUpload(alice, id, position, image.subarray(position, position + chunkSize));
  const saved = await finishUpload(alice, id);
  assert.equal(saved.name, details.name);
  assert.deepEqual(await readFile(path.join(directory, 'photos', 'alice', details.name)), image);
  assert.equal((await finishUpload(alice, id)).id, saved.id);
  assert.equal((await startUpload(alice, id, details)).photo?.id, saved.id);
  assert.deepEqual(await readdir(path.join(directory, 'photos', 'alice')), [details.name]);
});

test('upload contents and identifiers remain private to the member and collection root', async () => {
  const id = 'private-upload-identifier';
  await startUpload(alice, id, details);
  await appendUpload(alice, id, 0, image.subarray(0, chunkSize));
  await assert.rejects(startUpload(bob, id, details), status(409));
  assert.equal((await startUpload(bob, id, { ...details, ownerScope: uploadScope(bob, 'browser-queue') })).offset, 0);
  assert.equal((await startUpload(alice, id, details)).offset, chunkSize);
  await assert.rejects(startUpload(alice, id, { ...details, name: 'another-photo.png' }), status(409));
  const oldRoot = process.env.PHOTO_ROOT;
  try { process.env.PHOTO_ROOT = path.join(directory, 'other-collection'); await assert.rejects(startUpload(alice, id, details), status(409)); }
  finally { process.env.PHOTO_ROOT = oldRoot; }
  await cancelResumableUpload(alice, id);
  assert.equal((await startUpload(alice, id, details)).offset, 0);
});

test('incorrect checksums are rejected before publishing a photo and quota failures preserve the received offset', async () => {
  const id = 'invalid-checksum-identifier';
  const small = await sharp({ create: { width: 20, height: 20, channels: 3, background: 'red' } }).png().toBuffer();
  await startUpload(alice, id, { ...details, name: 'invalid-hash.png', size: small.length, checksum: '0'.repeat(64) });
  await appendUpload(alice, id, 0, small);
  await assert.rejects(finishUpload(alice, id), status(400));
  assert(!(await readdir(path.join(directory, 'photos', 'alice'))).includes('invalid-hash.png'));
  const quota = path.join(directory, 'data', 'resumable', 'quota.part');
  await writeFile(quota, ''); await truncate(quota, 1024 * 1024 * 1024);
  try {
    await startUpload(alice, id, details);
    await assert.rejects(appendUpload(alice, id, 0, small), status(507));
    assert.equal((await startUpload(alice, id, details)).offset, 0);
  } finally { await unlink(quota); }
});

test('a truncated request and an oversized chunk never advance the durable upload position', async () => {
  const id = 'truncated-chunk-identifier';
  await startUpload(alice, id, details);
  const route = await import('../src/routes/api/upload/resumable/[id]/+server');
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(image.subarray(0, 20)); controller.error(new Error('connection closed')); } });
  const request = new Request('http://localhost/api/upload/resumable/test', { method: 'PATCH', headers: { 'upload-offset': '0' }, body, duplex: 'half' } as RequestInit);
  assert.equal((await route.PATCH({ request, params: { id }, locals: { user: alice } } as never)).status, 408);
  assert.equal((await startUpload(alice, id, details)).offset, 0);
  const oversized = new Request('http://localhost/api/upload/resumable/test', { method: 'PATCH', headers: { 'upload-offset': '0' }, body: image.subarray(0, chunkSize + 1) });
  assert.equal((await route.PATCH({ request: oversized, params: { id }, locals: { user: alice } } as never)).status, 413);
  assert.equal((await startUpload(alice, id, details)).offset, 0);
});
