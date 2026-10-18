import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, statSync, symlinkSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const directory = mkdtempSync(path.join(os.tmpdir(), 'gather-admin-'));
process.env.DATA_ROOT = path.join(directory, 'data');
process.env.PHOTO_ALLOWED_ROOT = path.join(directory, 'library');
process.env.PHOTO_ROOT = path.join(directory, 'library', 'trip');
process.env.IMMICH_ALLOWED_ROOT = '/external/photos';
mkdirSync(process.env.PHOTO_ROOT, { recursive: true });
mkdirSync(path.join(directory, 'elsewhere'));
symlinkSync(path.join(directory, 'elsewhere'), path.join(directory, 'library', 'escape'));
const admin = await import('../src/lib/server/admin');
const settings = await import('../src/lib/server/settings');
const auth = await import('../src/lib/server/auth');
after(() => rmSync(directory, { recursive: true, force: true }));

test('administrator setup requires a private token, is single use, and stores hashed credentials', () => {
  admin.ensureSetupToken();
  const filename = path.join(process.env.DATA_ROOT!, 'admin-setup-token');
  assert.equal(statSync(filename).mode & 0o777, 0o600);
  const token = readFileSync(filename, 'utf8');
  assert.throws(() => admin.setupAdmin('x'.repeat(43), 'long-password-123'), /Invalid setup token/);
  assert.throws(() => admin.setupAdmin(token, 'short'), /12 and 256/);
  const session = admin.setupAdmin(token, 'long-password-123');
  assert.equal(admin.adminConfigured(), true);
  assert.equal(admin.getAdminSession(session), true);
  assert.equal(existsSync(filename), false);
  assert.throws(() => admin.setupAdmin(token, 'another-password-123'), /already configured/);
  assert.throws(() => admin.loginAdmin('incorrect'), /Incorrect/);
  const loggedIn = admin.loginAdmin('long-password-123');
  assert.equal(admin.getAdminSession(loggedIn), true);
  admin.logoutAdmin(loggedIn);
  assert.equal(admin.getAdminSession(loggedIn), false);
  assert.equal(admin.getAdminSession('invalid'), false);
  assert.equal(readFileSync(path.join(process.env.DATA_ROOT!, 'admin.sqlite')).includes(Buffer.from('long-password-123')), false);
});

test('folder selection stays within allowed root, excludes symlinks and configuration files, and maps Immich automatically', () => {
  assert.equal(admin.validatePhotoRoot(process.env.PHOTO_ROOT!), process.env.PHOTO_ROOT);
  assert.throws(() => admin.validatePhotoRoot(path.join(directory, 'elsewhere')), /mounted photo/);
  assert.throws(() => admin.validatePhotoRoot(path.join(directory, 'library', 'escape')), /Symbolic/);
  const input = { ...settings.readSettings(), collectionName: 'Our trip', immichUrl: 'http://immich:2283', immichPhotoRoot: '/wrong/path', immichApiKey: 'preview-secret' };
  const saved = admin.validateSettings(input);
  assert.equal(saved.immichPhotoRoot, '/external/photos/trip');
  settings.writeSettings(saved);
  assert.equal(settings.readSettings().collectionName, 'Our trip');
  assert.equal(statSync(path.join(process.env.DATA_ROOT!, 'settings.json')).mode & 0o777, 0o600);
  assert.equal(admin.validateSettings({ ...saved, immichApiKey: '' }).immichApiKey, 'preview-secret');
});

test('switching a collection revokes every guest identity and invitation while preserving directories', async () => {
  const shared = auth.createShareLink();
  const guest = (await auth.joinCollection(shared, 'Guest'));
  const personal = (await auth.createMember('Niels'));
  const individual = auth.exchangeInvite(personal.token)!;
  auth.resetCollectionAccess();
  assert.equal(auth.getSession(guest.sessionToken), null);
  assert.equal(auth.getSession(individual.sessionToken), null);
  assert.equal(auth.exchangeInvite(personal.token), null);
  (await assert.rejects(async () => (await auth.joinCollection(shared, 'Another guest')), /revoked/));
  assert.equal(existsSync(path.join(process.env.PHOTO_ROOT!, 'Niels')), true);
});

test('request snapshots retain the selected collection during concurrent changes', async () => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const original = settings.readSettings();
  const request = settings.withSettings(async () => {
    await wait;
    assert.equal(settings.readSettings().collectionName, original.collectionName);
  });
  settings.writeSettings({ ...original, collectionName: 'Another collection' });
  release();
  await request;
  assert.equal(settings.readSettings().collectionName, 'Another collection');
});


test('a fresh installation creates its configured available-folder root', () => {
  const previous = process.env.PHOTO_ALLOWED_ROOT;
  const root = path.join(directory, 'fresh-photos');
  process.env.PHOTO_ALLOWED_ROOT = root;
  try {
    assert.equal(admin.allowedPhotoRoot(), root);
    assert.equal(statSync(root).isDirectory(), true);
  } finally { process.env.PHOTO_ALLOWED_ROOT = previous; }
});
