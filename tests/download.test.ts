import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import sharp from 'sharp';
const directory = mkdtempSync(path.join(os.tmpdir(), 'gather-download-'));
process.env.PHOTO_ROOT = path.join(directory, 'photos');
process.env.DATA_ROOT = path.join(directory, 'data');
const auth = await import('../src/lib/server/auth');
const media = await import('../src/lib/server/media');
const options = await import('../src/lib/server/download-options');
const { POST } = await import('../src/routes/api/download/+server');
const alice = (await auth.createMember('Alice')).member;
const bob = (await auth.createMember('Bob')).member;
const red = await sharp({ create: { width: 20, height: 20, channels: 3, background: 'red' } }).png().toBuffer();
const blue = await sharp({ create: { width: 20, height: 20, channels: 3, background: 'blue' } }).png().toBuffer();
writeFileSync(path.join(process.env.PHOTO_ROOT!, 'Alice', 'self.png'), red);
writeFileSync(path.join(process.env.PHOTO_ROOT!, 'Bob', 'trip.png'), red);
after(() => rmSync(directory, { recursive: true, force: true }));
function download(folders: string[], updatesOnly = false) {
  return POST({ request: new Request('http://localhost/api/download', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ options: { folders, updatesOnly } }) }), locals: { user: alice } } as any);
}
test('archives filter contributors case-insensitively and advance only their completed file revisions', async () => {
  assert.equal((await options.downloadInventory(alice)).contributors.find(p => p.folder === 'bob')?.updates, 1);
  const response = await download(['BOB']);
  assert.equal(response.status, 200);
  const archive = Buffer.from(await response.arrayBuffer());
  assert.ok(archive.includes(Buffer.from('Bob/trip.png')));
  assert.equal(archive.includes(Buffer.from('Alice/self.png')), false);
  const inventory = await options.downloadInventory(alice);
  assert.equal(inventory.contributors.find(p => p.folder === 'bob')?.updates, 0);
  assert.equal(inventory.contributors.find(p => p.folder === 'alice')?.updates, 1);
  assert.equal(auth.downloadedPhotos(bob).size, 0);
  assert.equal((await download(['Bob'], true)).status, 400);
});
test('new files with old timestamps and modified originals remain updates', async () => {
  const old = path.join(process.env.PHOTO_ROOT!, 'Bob', 'old.png');
  writeFileSync(old, red); utimesSync(old, new Date('2000-01-01'), new Date('2000-01-01'));
  writeFileSync(path.join(process.env.PHOTO_ROOT!, 'Bob', 'trip.png'), blue);
  media.invalidatePhotos();
  const photos = await options.chooseDownload(alice, { folders: ['Bob'], updatesOnly: true });
  assert.deepEqual(photos.map(p => p.name).sort(), ['old.png', 'trip.png']);
  const response = await download(['Bob'], true); await response.arrayBuffer();
  assert.equal((await options.downloadInventory(alice)).contributors.find(p => p.folder === 'bob')?.updates, 0);
});
test('cancelled archives do not mark untouched photos downloaded', async () => {
  const response = await download(['Alice']);
  await response.body!.cancel();
  assert.equal((await options.downloadInventory(alice)).contributors.find(p => p.folder === 'alice')?.updates, 1);
});
test('viewing full resolution does not advance history, but downloading the original does', async () => {
  const { GET } = await import('../src/routes/api/media/[id]/+server');
  const id = media.encodeId('Alice/self.png');
  const get = (kind: string) => GET({ params: { id }, url: new URL(`http://localhost/api/media/${id}?kind=${kind}`), request: new Request('http://localhost'), locals: { user: alice } } as any);
  const viewing = await get('fullsize'); await viewing.arrayBuffer();
  assert.equal(auth.downloadedPhotos(alice).has(id), false);
  const original = await get('original'); await original.arrayBuffer();
  assert.equal(auth.downloadedPhotos(alice).has(id), true);
});
test('download tickets are single-use and cannot be consumed by another member', async () => {
  const choice = { folders: ['Bob'], updatesOnly: false };
  const ticket = auth.createDownloadTicket(alice, choice);
  assert.equal(auth.takeDownloadTicket(bob, ticket), undefined);
  assert.deepEqual(auth.takeDownloadTicket(alice, ticket), choice);
  assert.equal(auth.takeDownloadTicket(alice, ticket), undefined);
  const { GET } = await import('../src/routes/api/download/+server');
  const token = auth.createDownloadTicket(alice, choice);
  const url = new URL(`http://localhost/api/download?ticket=${token}`);
  const event = { request: new Request(url), url, locals: { user: alice } } as any;
  const archive = await GET(event); assert.equal(archive.status, 200);
  assert.ok(Buffer.from(await archive.arrayBuffer()).includes(Buffer.from('Bob/trip.png')));
  assert.equal((await GET(event)).status, 410);
});
