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
await (await import('../src/lib/server/contributor-folders')).ensureCanonicalFolders();
after(() => rmSync(root, { recursive: true, force: true }));
test('legacy duplicate names become one contributor with one capitalized folder while sessions, invitations and originals still work', async () => {
  const members = auth.listMembers();
  assert.equal(members.length, 2);
  const niels = members.find(m => m.name === 'Niels')!;
  assert.equal(niels.folder, 'Niels'); assert.equal('folders' in niels, false);
  assert.equal(auth.getSession('b'.repeat(43))?.id, 'first');
  assert.equal(auth.exchangeInvite('B'.repeat(43))?.member.id, 'first');
  const photos = await media.scanPhotos(members);
  assert.equal(photos.filter(p => p.folder === 'Niels').length, 2);
  assert.equal(photos.filter(p => p.folder === 'Ge').length, 2);
  assert.ok(photos.some(p => media.decodeId(p.id) === 'Niels/second.jpg'));
  const link = auth.createShareLink();
  assert.equal((await auth.joinCollection(link, ' NIELS ')).member.id, 'first');
  assert.equal(auth.accessOverview().members.length, 2);
  (await assert.rejects(async () => (await auth.createMember('GE')), /already belongs/));
});
test('rotating a merged identity revokes all legacy sessions and invitations', () => {
  auth.rotateMember('Niels');
  assert.equal(auth.getSession('b'.repeat(43)), null);
  assert.equal(auth.exchangeInvite('B'.repeat(43)), null);
});

test('a persisted folder journal recovers after interruption between directory rename steps', async () => {
  const { readFile, writeFile, rename, readdir } = await import('node:fs/promises');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const source = (await auth.createMember('recovery source')).member;
  writeFileSync(path.join(process.env.PHOTO_ROOT!, source.folder, 'preserved.jpg'), 'recovery original');
  const target = await auth.renameMember(source.id, 'recovery target');
  const data = process.env.DATA_ROOT!;
  const plan = JSON.parse(await readFile(path.join(data, 'last-folder-migration.json'), 'utf8'));
  plan.committed = false;
  await rename(path.join(plan.root, plan.renames[0].to), path.join(plan.root, plan.renames[0].temporary));
  await writeFile(path.join(data, 'folder-journal.json'), JSON.stringify(plan), { mode: 0o600 });
  await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', "const {ensureCanonicalFolders}=await import('./src/lib/server/contributor-folders.ts'); await ensureCanonicalFolders();"], { cwd: process.cwd(), timeout: 20_000 });
  assert.equal(await readFile(path.join(plan.root, target.folder, 'preserved.jpg'), 'utf8'), 'recovery original');
  assert.equal((await readdir(plan.root)).includes(source.folder), false);
  assert.equal((await readdir(data)).includes('folder-journal.json'), false);
  assert.equal(auth.listMembers().find(member => member.id === source.id)?.folder, target.folder);
});

test('recovery verifies identical contents when the filesystem reports different hardlink inodes', async () => {
  const fs = await import('node:fs/promises');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  for (const folder of ['Sshfs person', 'sshfs person']) {
    await fs.mkdir(path.join(process.env.PHOTO_ROOT!, folder));
    await fs.writeFile(path.join(process.env.PHOTO_ROOT!, folder, 'original.jpg'), folder);
  }
  await auth.createMember('sshfs person');
  const data = process.env.DATA_ROOT!;
  const plan = JSON.parse(await fs.readFile(path.join(data, 'last-folder-migration.json'), 'utf8'));
  const move = plan.moves[0];
  assert.ok(move && !move.directory);
  await fs.mkdir(path.dirname(path.join(plan.root, move.from)), { recursive: true });
  await fs.copyFile(path.join(plan.root, move.to), path.join(plan.root, move.from));
  const timestamp = Math.floor(Date.now() / 1000);
  for (const name of [move.from, move.to]) await fs.utimes(path.join(plan.root, name), timestamp, timestamp);
  move.mtime = (await fs.lstat(path.join(plan.root, move.from))).mtimeMs;
  plan.committed = false;
  await fs.writeFile(path.join(data, 'folder-journal.json'), JSON.stringify(plan), { mode: 0o600 });
  await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', "const {ensureCanonicalFolders}=await import('./src/lib/server/contributor-folders.ts'); await ensureCanonicalFolders();"], { cwd: process.cwd(), timeout: 20_000 });
  assert.equal(await fs.readFile(path.join(plan.root, move.to), 'utf8'), 'sshfs person');
  assert.equal((await fs.readdir(plan.root)).includes('sshfs person'), false);
});
