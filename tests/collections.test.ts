import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, statSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { collectionBase, collectionIdFromPath, collectionPath } from '../src/lib/collection-path';

const directory = mkdtempSync(path.join(os.tmpdir(), 'gather-collections-'));
process.env.DATA_ROOT = path.join(directory, 'data');
process.env.PHOTO_ROOT = path.join(directory, 'one');
mkdirSync(process.env.PHOTO_ROOT, { recursive: true });
mkdirSync(path.join(directory, 'two'));
const settings = await import('../src/lib/server/settings');
const auth = await import('../src/lib/server/auth');
const media = await import('../src/lib/server/media');
after(() => rmSync(directory, { recursive: true, force: true }));
let id = '', defaultSession = '', secondSession = '', defaultInvite = '', shared = '';

test('existing settings, identities, sessions, and invitations remain in the default collection', () => {
  const member = auth.createMember('Niels', 'Niels');
  defaultInvite = member.token;
  defaultSession = auth.exchangeInvite(member.token)!.sessionToken;
  shared = auth.createShareLink();
  const original = settings.readSettings();
  id = settings.createCollection({ ...original, collectionName: 'Another trip', photoRoot: path.join(directory, 'two'), immichUrl: '', immichApiKey: '', immichScanApiKey: '', immichLibraryId: '', immichPhotoRoot: '' });
  assert.equal(settings.readSettings().photoRoot, original.photoRoot);
  assert.equal(auth.getSession(defaultSession)?.name, 'Niels');
  assert.equal(settings.sessionCookieName(), 'gather_session');
  assert.equal(settings.listCollections().length, 2);
  assert.equal(statSync(path.join(directory, 'data', 'collections.json')).mode & 0o777, 0o600);
});

test('each collection isolates members, identical folder names, invitation tokens, shared links, and guest sessions', async () => {
  await settings.withSettings(async () => {
    assert.equal(settings.currentCollectionId(), id);
    assert.equal(auth.listMembers().length, 0);
    assert.equal(auth.getSession(defaultSession), null);
    assert.equal(auth.exchangeInvite(defaultInvite), null);
    assert.throws(() => auth.joinCollection(shared, 'Outsider'), (error: any) => error.status === 401);
    const member = auth.createMember('Another Niels', 'Niels');
    secondSession = auth.exchangeInvite(member.token)!.sessionToken;
    assert.equal(auth.listMembers().length, 1);
    assert.equal(auth.getSession(secondSession)?.name, 'Another Niels');
    assert.notEqual(settings.sessionCookieName(), 'gather_session');
    await Promise.resolve();
    assert.equal(settings.readSettings().collectionName, 'Another trip');
    settings.writeSettings({ ...settings.readSettings(), collectionName: 'Renamed trip' });
  }, id);
  assert.equal(auth.getSession(secondSession), null);
  assert.equal(auth.getSession(defaultSession)?.name, 'Niels');
  assert.equal(auth.listMembers().length, 1);
  assert.notEqual(settings.readSettings().collectionName, 'Renamed trip');
  assert.equal(settings.listCollections().find(item => item.id === id)?.name, 'Renamed trip');
  assert.equal(JSON.parse(readFileSync(path.join(directory, 'data', 'collections', id, 'settings.json'), 'utf8')).collectionName, 'Renamed trip');
});

test('concurrent collection requests keep their settings, gallery scans, media paths, and revocations separate', async () => {
  const images = await Promise.all(['#123456', '#abcdef'].map(background => sharp({ create: { width: 12, height: 12, channels: 3, background } }).png().toBuffer()));
  await Promise.all(['one', 'two'].map((root, index) => writeFile(path.join(directory, root, 'Niels', 'same.png'), images[index])));
  for (let round = 0; round < 2; round++) {
    await Promise.all(['default', id].map((collection, index) => settings.withSettings(async () => {
      const photos = await media.scanPhotos(auth.listMembers());
      assert.equal(photos.length, 1);
      assert.equal(photos[0].owner, index ? 'Another Niels' : 'Niels');
      const file = await media.openPhoto(photos[0].id);
      try { assert.deepEqual(await file.handle.readFile(), images[index]); }
      finally { await file.handle.close(); }
      assert.equal(settings.currentCollectionId(), collection);
    }, collection)));
  }
  settings.withSettings(() => auth.resetCollectionAccess(), id);
  assert.equal(auth.getSession(defaultSession)?.name, 'Niels');
  assert.equal(settings.withSettings(() => auth.getSession(secondSession), id), null);
});

test('collection paths preserve the configured app base and reject unknown collection identifiers', () => {
  assert.equal(collectionPath('/gather', id), `/gather/c/${id}`);
  assert.equal(collectionBase(`/gather/c/${id}/api/photos`, '/gather'), `/gather/c/${id}`);
  assert.equal(collectionIdFromPath('/gather/admin', '/gather'), 'default');
  assert.equal(collectionPath('/gather', 'default'), '/gather');
  assert.equal(collectionPath('', id), `/c/${id}`);
  assert.throws(() => settings.withSettings(() => {}, 'missing'), (error: any) => error.status === 404);
  assert.throws(() => settings.withSettings(() => {}, '../private'));
});


test('guest sign-in throttling is isolated per collection while the administrator limit remains global', async () => {
  const { allowAuthAttempt } = await import('../src/lib/server/auth-http');
  assert.equal(allowAuthAttempt('collection-test', 'session', 1), true);
  assert.equal(allowAuthAttempt('collection-test', 'session', 1), false);
  assert.equal(settings.withSettings(() => allowAuthAttempt('collection-test', 'session', 1), id), true);
  assert.equal(allowAuthAttempt('admin-test', 'admin', 1), true);
  assert.equal(settings.withSettings(() => allowAuthAttempt('admin-test', 'admin', 1), id), false);
});
