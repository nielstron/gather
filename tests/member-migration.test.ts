import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import Database from 'better-sqlite3';
const root = mkdtempSync(path.join(os.tmpdir(), 'gather-names-'));
process.env.PHOTO_ROOT = path.join(root, 'photos');
process.env.DATA_ROOT = path.join(root, 'data');
mkdirSync(process.env.DATA_ROOT);
const db = new Database(path.join(process.env.DATA_ROOT, 'auth.sqlite'));
db.exec(`CREATE TABLE members (id TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL UNIQUE, invite_hash TEXT UNIQUE, created_at INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1, shared INTEGER NOT NULL DEFAULT 1);
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id), expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);`);
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
for (const [id, name, folder, token] of [['first', 'Niels', 'Niels', 'A'], ['second', ' nIELS ', 'niels-old', 'B'], ['ge', 'Ge', 'ge-old', 'C']]) {
  mkdirSync(path.join(process.env.PHOTO_ROOT, folder), { recursive: true });
  writeFileSync(path.join(process.env.PHOTO_ROOT, folder, `${id}.jpg`), 'original');
  db.prepare('INSERT INTO members VALUES (?, ?, ?, ?, ?, 1, 1)').run(id, name, folder, hash(token.repeat(43)), id === 'first' ? 1 : 2);
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(hash(token.toLowerCase().repeat(43)), id, Date.now() + 60_000, Date.now());
}
mkdirSync(path.join(process.env.PHOTO_ROOT, 'Ge')); writeFileSync(path.join(process.env.PHOTO_ROOT, 'Ge', 'existing.jpg'), 'original');
db.close();
const auth = await import('../src/lib/server/auth');
const media = await import('../src/lib/server/media');
after(() => rmSync(root, { recursive: true, force: true }));
test('legacy duplicate names become one contributor while sessions, invitations and originals still work', async () => {
  const members = auth.listMembers();
  assert.equal(members.length, 2);
  const niels = members.find(m => m.name === 'Niels')!;
  assert.equal(niels.folder, 'Niels'); assert.deepEqual(niels.folders, ['niels-old']);
  assert.equal(auth.getSession('b'.repeat(43))?.id, 'first');
  assert.equal(auth.exchangeInvite('B'.repeat(43))?.member.id, 'first');
  const photos = await media.scanPhotos(members);
  assert.equal(photos.filter(p => p.folder === 'Niels').length, 2);
  assert.equal(photos.filter(p => p.folder === 'ge-old').length, 2);
  assert.ok(photos.some(p => media.decodeId(p.id) === 'niels-old/second.jpg'));
  const link = auth.createShareLink();
  assert.equal(auth.joinCollection(link, ' NIELS ').member.id, 'first');
  assert.equal(auth.accessOverview().members.length, 2);
  assert.throws(() => auth.createMember('Another Ge', 'Ge'), /already has a member/);
});
test('rotating a merged identity revokes all legacy sessions and invitations', () => {
  auth.rotateMember('Niels');
  assert.equal(auth.getSession('b'.repeat(43)), null);
  assert.equal(auth.exchangeInvite('B'.repeat(43)), null);
});
