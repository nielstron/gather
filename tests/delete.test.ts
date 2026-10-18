import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, lstat, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
const directory = await mkdtemp(path.join(os.tmpdir(), 'gather-delete-'));
process.env.DATA_ROOT = path.join(directory, 'data');
process.env.PHOTO_ROOT = path.join(directory, 'photos');
const settings = await import('../src/lib/server/settings');
const auth = await import('../src/lib/server/auth');
const media = await import('../src/lib/server/media');
const route = await import('../src/routes/api/photos/+server');
const alice = (await auth.createMember('Alice')).member;
const bob = (await auth.createMember('Bob')).member;
const original = Buffer.from('An original that deletion must never read or modify elsewhere.');
after(() => rm(directory, { recursive: true, force: true }));
const status = (code: number) => (error: unknown) => error instanceof media.MediaError && error.status === code;
async function photo(relative: string) {
  const file = path.join(process.env.PHOTO_ROOT!, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, original);
  const opened = await media.openPhoto(media.encodeId(relative));
  await opened.handle.close();
  return { id: media.encodeId(relative), revision: opened.revision };
}
async function exists(relative: string) { return lstat(path.join(process.env.PHOTO_ROOT!, relative)).then(() => true, () => false); }

test('a mixed-owner batch, forged aliases, unassigned originals, and invalid paths are rejected before deletion', async () => {
  const mine = await photo('Alice/mixed.jpg'), theirs = await photo('Bob/mixed.jpg'), unassigned = await photo('shared.jpg');
  await assert.rejects(media.deletePhotos(alice, [mine, theirs]), status(403));
  await assert.rejects(media.deletePhotos({ ...alice, folders: ['bob'] } as typeof alice, [theirs]), status(403));
  await assert.rejects(media.deletePhotos(alice, [unassigned]), status(403));
  await assert.rejects(media.deletePhotos(alice, [{ id: Buffer.from('Alice/../Bob/mixed.jpg').toString('base64url'), revision: mine.revision }]), status(400));
  await assert.rejects(media.deletePhotos(alice, [{ ...mine, revision: '' }]), status(400));
  await assert.rejects(media.deletePhotos(alice, []), status(400));
  await assert.rejects(media.deletePhotos(alice, Array(201).fill(mine)), status(400));
  assert.deepEqual(await readFile(path.join(process.env.PHOTO_ROOT!, 'Bob/mixed.jpg')), original);
  assert.equal(await exists('Alice/mixed.jpg'), true);
  assert.equal(await exists('shared.jpg'), true);
});

test('changed originals and symlinks stop a batch without removing valid originals', async () => {
  const mine = await photo('Alice/valid.jpg'), changed = await photo('Alice/changed.jpg');
  await writeFile(path.join(process.env.PHOTO_ROOT!, 'Alice/changed.jpg'), 'replacement original');
  await assert.rejects(media.deletePhotos(alice, [mine, changed]), status(409));
  assert.equal(await exists('Alice/valid.jpg'), true);
  await symlink(path.join(process.env.PHOTO_ROOT!, 'Bob/mixed.jpg'), path.join(process.env.PHOTO_ROOT!, 'Alice/link.jpg'));
  await assert.rejects(media.deletePhotos(alice, [mine, { id: media.encodeId('Alice/link.jpg'), revision: mine.revision }]), status(404));
  await symlink(path.join(process.env.PHOTO_ROOT!, 'bob'), path.join(process.env.PHOTO_ROOT!, 'Alice/escape'));
  await assert.rejects(media.deletePhotos(alice, [{ id: media.encodeId('Alice/escape/mixed.jpg'), revision: mine.revision }]), status(404));
  assert.equal(await exists('Alice/valid.jpg'), true);
  assert.equal(await exists('Bob/mixed.jpg'), true);
});

test('owned nested files delete together, disappear from caches, and safely tolerate retries', async () => {
  const first = await photo('Alice/day/one.jpg'), second = await photo('Alice/another/two.jpg');
  media.invalidatePhotos();
  const before = await media.scanPhotos(auth.listMembers());
  assert.equal(before.some(item => item.id === first.id), true);
  const receipt = before.find(item => item.id === first.id)!;
  auth.writeUploadReceipt('test-scope', 'fingerprint', receipt);
  const result = await media.deletePhotos(alice, [first, second, first]);
  assert.deepEqual(new Set(result.deleted), new Set([first.id, second.id]));
  assert.deepEqual(result.failed, []);
  assert.equal(await exists('Alice/day/one.jpg'), false);
  assert.equal(await exists('Alice/another/two.jpg'), false);
  assert.equal(auth.readUploadReceipt('test-scope', 'fingerprint'), null);
  const after = await media.scanPhotos(auth.listMembers(), true);
  assert.equal(after.some(item => result.deleted.includes(item.id)), false);
  await assert.rejects(media.previewPath(first.id), status(404));
  assert.deepEqual((await media.deletePhotos(alice, [first])).deleted, [first.id]);
  const replaced = await photo('Alice/day/one.jpg');
  media.invalidatePhotos();
  assert.notEqual(replaced.revision, first.revision);
  assert.equal((await media.scanPhotos(auth.listMembers())).some(item => item.id === first.id), true);
});

test('read-only collections reject deletes and collection boundaries include file versions', async () => {
  const mine = await photo('Alice/read-only.jpg');
  const initial = settings.readSettings();
  settings.writeSettings({ ...initial, readOnly: true });
  try { await assert.rejects(media.deletePhotos(alice, [mine]), status(403)); }
  finally { settings.writeSettings(initial); }
  assert.equal(await exists('Alice/read-only.jpg'), true);
  const root = path.join(directory, 'other'); await mkdir(root);
  const id = settings.createCollection({ ...initial, photoRoot: root });
  await settings.withSettings(async () => {
    const other = (await auth.createMember('Alice')).member;
    await mkdir(path.join(root, 'alice'), { recursive: true }); await writeFile(path.join(root, 'Alice/read-only.jpg'), original);
    await assert.rejects(media.deletePhotos(other, [mine]), status(409));
    await assert.rejects(media.deletePhotos(alice, [mine]), status(403));
    assert.deepEqual(await readFile(path.join(root, 'Alice/read-only.jpg')), original);
  }, id);
});

test('the delete API requires a session and bounded valid JSON', async () => {
  function event(body: string, user = alice as typeof alice | null) {
    return { request: new Request('http://localhost/api/photos', { method: 'DELETE', body }), locals: { user } } as any;
  }
  assert.equal((await route.DELETE(event('{}', null))).status, 401);
  assert.equal((await route.DELETE(event('{'))).status, 400);
  assert.equal((await route.DELETE(event('null'))).status, 400);
  assert.equal((await route.DELETE(event(' '.repeat(1024 * 1024 + 1)))).status, 413);
});
