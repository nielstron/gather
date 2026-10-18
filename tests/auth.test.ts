import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import Database from 'better-sqlite3';

const directory = mkdtempSync(path.join(os.tmpdir(), 'gather-auth-'));
process.env.PHOTO_ROOT = path.join(directory, 'photos');
process.env.DATA_ROOT = path.join(directory, 'data');
mkdirSync(process.env.DATA_ROOT);
const legacy = new Database(path.join(directory, 'data/auth.sqlite'));
legacy.exec(`
  CREATE TABLE members (id TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL UNIQUE, invite_hash TEXT UNIQUE, created_at INTEGER NOT NULL);
  CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id), expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
`);
for (const active of [true, false]) {
  const id = active ? 'legacy-live' : 'legacy-revoked';
  legacy.prepare('INSERT INTO members VALUES (?, ?, ?, ?, ?)').run(id, id, id, active ? 'legacy-invite-hash' : null, Date.now());
  legacy.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(createHash('sha256').update((active ? 'L' : 'R').repeat(43)).digest('hex'), id, Date.now() + 60_000, Date.now());
}
legacy.close();
const auth = await import('../src/lib/server/auth');
await (await import('../src/lib/server/contributor-folders')).ensureCanonicalFolders();
after(() => rmSync(directory, { recursive: true, force: true }));

test('legacy database migration preserves live sessions without restoring revoked users', () => {
  assert.equal(auth.getSession('L'.repeat(43))?.folder, 'Legacy-live');
  assert.equal(auth.getSession('R'.repeat(43)), null);
});

test('invitations create independent sessions and only hashes are stored', async () => {
  const { member, token } = (await auth.createMember('Alice'));
  assert.equal(token.length, 43);
  assert.equal(member.folder, 'Alice');
  const first = auth.exchangeInvite(token)!;
  const second = auth.exchangeInvite(token)!;
  assert.notEqual(first.sessionToken, token);
  assert.notEqual(first.sessionToken, second.sessionToken);
  assert.deepEqual(auth.getSession(first.sessionToken), member);
  assert.deepEqual(auth.getSession(second.sessionToken), member);
  const db = new Database(path.join(directory, 'data/auth.sqlite'), { readonly: true });
  const row = db.prepare('SELECT invite_hash FROM members WHERE id = ?').get(member.id) as { invite_hash: string };
  assert.equal(row.invite_hash, createHash('sha256').update(token).digest('hex'));
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM sessions').all()).includes(first.sessionToken), false);
  db.close();
  assert.equal(readFileSync(path.join(directory, 'data/auth.sqlite')).includes(token), false);
  auth.deleteSession(first.sessionToken);
  assert.equal(auth.getSession(first.sessionToken), null);
  assert.deepEqual(auth.getSession(second.sessionToken), member);
});

test('rotation and revocation invalidate old invitations and every session', async () => {
  const original = (await auth.createMember('Bea'));
  const session = auth.exchangeInvite(original.token)!;
  const rotated = auth.rotateMember('bea');
  assert.deepEqual(rotated.member, original.member);
  assert.equal(auth.exchangeInvite(original.token), null);
  assert.equal(auth.getSession(session.sessionToken), null);
  const replacement = auth.exchangeInvite(rotated.token)!;
  auth.revokeMember('bea');
  assert.equal(auth.getSession(replacement.sessionToken), null);
  assert.equal(auth.exchangeInvite(rotated.token), null);
  assert.ok(auth.listMembers().some((member) => member.id === original.member.id));
  (await assert.rejects(async () => (await auth.createMember('BEA')), /already belongs/));
});

test('sessions expire and malformed tokens fail safely', async () => {
  const { token } = (await auth.createMember('Charlie'));
  const session = auth.exchangeInvite(token)!;
  const db = new Database(path.join(directory, 'data/auth.sqlite'));
  db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?')
    .run(Date.now() - 1, createHash('sha256').update(session.sessionToken).digest('hex'));
  db.close();
  assert.equal(auth.getSession(session.sessionToken), null);
  assert.equal(auth.getSession(undefined), null);
  assert.equal(auth.getSession('bad'), null);
  assert.equal(auth.exchangeInvite('x'.repeat(100_000)), null);
});

test('names cannot escape the root, duplicate contributors, or claim a symbolic link', async () => {
  for (const name of ['../escape', 'alice/other', '/tmp', '.', '..', 'bad:name', 'a'.repeat(81), 'bad\nname']) await assert.rejects(auth.createMember(name), /Display name/);
  await assert.rejects(auth.createMember('ALICE'), /already belongs/);
  await assert.rejects(auth.createMember('  '), /Display name/);
  symlinkSync(directory, path.join(directory, 'photos', 'symlink'));
  await assert.rejects(auth.createMember('Symlink'), /shareable directory/);
});

test('reusable invitations retain only a bounded number of sessions', async () => {
  const { token } = (await auth.createMember('Drew'));
  const oldest = auth.exchangeInvite(token)!;
  let newest = oldest;
  for (let index = 0; index < 25; index++) newest = auth.exchangeInvite(token)!;
  assert.equal(auth.getSession(oldest.sessionToken), null);
  assert.equal(auth.getSession(newest.sessionToken)?.folder, 'Drew');
});

test('a shared link stores only its hash and same-name visitors reuse their identity and claim existing folders', async () => {
  const token = auth.createShareLink();
  assert.equal(token.length, 43);
  assert.throws(() => auth.createShareLink(), /already exists/);
  const first = (await auth.joinCollection(token, 'Alex'));
  const second = (await auth.joinCollection(token, '  aLeX  '));
  assert.equal(first.member.name, second.member.name);
  assert.equal(first.member.id, second.member.id);
  assert.equal(first.member.folder, second.member.folder);
  assert.deepEqual(auth.getSession(first.sessionToken), first.member);
  assert.deepEqual(auth.getSession(second.sessionToken), second.member);
  const collision = (await auth.joinCollection(token, 'Alice'));
  assert.equal(collision.member.folder, 'Alice');
  mkdirSync(path.join(directory, 'photos', 'existing'));
  writeFileSync(path.join(directory, 'photos', 'existing', 'keep.txt'), 'existing files');
  assert.equal((await auth.joinCollection(token, 'Existing')).member.folder, 'Existing');
  assert.equal(readFileSync(path.join(directory, 'photos/Existing/keep.txt'), 'utf8'), 'existing files');
  const unicode = (await auth.joinCollection(token, '日本語'));
  assert.equal(unicode.member.folder, '日本語');
  const db = new Database(path.join(directory, 'data/auth.sqlite'), { readonly: true });
  const row = db.prepare('SELECT token_hash FROM shared_link WHERE id = 1').get() as { token_hash: string };
  assert.equal(row.token_hash, createHash('sha256').update(token).digest('hex'));
  db.close();
});

test('shared link rotation and revocation invalidate shared sessions, preserving personal access and photos', async () => {
  const personal = (await auth.createMember('Private member'));
  const personalSession = auth.exchangeInvite(personal.token)!;
  const originalToken = auth.rotateShareLink();
  const shared = (await auth.joinCollection(originalToken, 'Shared Friend'));
  const filename = path.join(directory, 'photos', shared.member.folder, 'photo.jpg');
  writeFileSync(filename, 'original bytes');
  const replacement = auth.rotateShareLink();
  assert.notEqual(replacement, originalToken);
  assert.equal(auth.getSession(shared.sessionToken), null);
  (await assert.rejects(async () => (await auth.joinCollection(originalToken, 'Someone')), (error: unknown) => error instanceof auth.AuthError && error.status === 401));
  assert.deepEqual(auth.getSession(personalSession.sessionToken), personal.member);
  const newest = (await auth.joinCollection(replacement, 'Shared Friend'));
  auth.revokeShareLink();
  assert.equal(auth.getSession(newest.sessionToken), null);
  (await assert.rejects(async () => (await auth.joinCollection(replacement, 'Someone')), /revoked/));
  assert.deepEqual(auth.getSession(personalSession.sessionToken), personal.member);
  assert.equal(readFileSync(filename, 'utf8'), 'original bytes');
  assert.ok(auth.listMembers().some((member) => member.id === shared.member.id));
});

test('changing a display name renames its one folder while preserving identity, sessions and originals', async () => {
  const token = auth.createShareLink();
  const joined = (await auth.joinCollection(token, 'Before Name'));
  const filename = path.join(directory, 'photos', joined.member.folder, 'photo.jpg');
  writeFileSync(filename, 'keep my photos');
  const renamed = (await auth.renameMember(joined.member.id, '  After Name  '));
  assert.equal(renamed.name, 'After Name');
  assert.equal(renamed.id, joined.member.id);
  assert.equal(renamed.folder, 'After Name');
  assert.equal(existsSync(path.dirname(filename)), false);
  assert.deepEqual(auth.getSession(joined.sessionToken), renamed);
  assert.equal(readFileSync(path.join(directory, 'photos', renamed.folder, 'photo.jpg'), 'utf8'), 'keep my photos');
  for (const name of ['', '   ', 'a'.repeat(81), 'bad\nname']) {
    (await assert.rejects(async () => (await auth.renameMember(joined.member.id, name)), /Display name/));
    (await assert.rejects(async () => (await auth.joinCollection(token, name)), /Display name/));
  }
});

test('join and profile APIs ignore client ownership fields and bound JSON bodies', async () => {
  const { POST } = await import('../src/routes/api/join/+server');
  const { PATCH } = await import('../src/routes/api/profile/+server');
  const token = auth.rotateShareLink();
  let session = '';
  const cookies = { set(name: string, value: string, options: { httpOnly: boolean }) {
    assert.equal(name, 'gather_session');
    assert.equal(options.httpOnly, true);
    session = value;
  } };
  const join = await POST({
    request: new Request('http://localhost/api/join', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, name: 'API Visitor', folder: 'alice', id: 'legacy-live' }) }),
    cookies, getClientAddress: () => 'auth-test'
  } as never);
  assert.equal(join.status, 200);
  const joined = (await join.json()).user;
  assert.notEqual(joined.folder, 'alice');
  assert.notEqual(joined.id, 'legacy-live');
  assert.equal(auth.getSession(session)?.id, joined.id);
  const profile = await PATCH({
    request: new Request('http://localhost/api/profile', { method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'API Renamed', id: 'legacy-live', folder: 'alice' }) }),
    locals: { user: joined }
  } as never);
  assert.equal(profile.status, 200);
  assert.equal((await profile.json()).user.folder, 'API Renamed');
  assert.equal(auth.getSession(session)?.name, 'API Renamed');
  const oversized = await POST({
    request: new Request('http://localhost/api/join', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, name: 'x'.repeat(2048) }) }),
    cookies, getClientAddress: () => 'auth-test'
  } as never);
  assert.equal(oversized.status, 400);
});


test('a personal invitation for a former group guest survives shared-link revocation', async () => {
  const shared = auth.rotateShareLink();
  const guest = (await auth.joinCollection(shared, 'Personal guest'));
  const invitation = auth.rotateMember(guest.member.folder);
  assert.equal(auth.getSession(guest.sessionToken), null);
  const session = auth.exchangeInvite(invitation.token)!;
  auth.revokeShareLink();
  assert.deepEqual(auth.getSession(session.sessionToken), guest.member);
  assert.equal((auth.accessOverview().members as { folder: string; shared: number }[]).find(member => member.folder === guest.member.folder)?.shared, 0);
});


test('personal invitations match existing folders and members regardless of capitalization', async () => {
  mkdirSync(path.join(directory, 'photos', 'ExistingPhotos'));
  writeFileSync(path.join(directory, 'photos', 'ExistingPhotos', 'memory.jpg'), 'original');
  const invitation = (await auth.createMember('existingPhotos'));
  assert.equal(invitation.member.folder, 'ExistingPhotos');
  (await assert.rejects(async () => (await auth.createMember('EXISTINGPHOTOS')), /already belongs/));
  assert.equal(auth.getSession(auth.exchangeInvite(invitation.token)!.sessionToken)?.folder, 'ExistingPhotos');
  assert.equal(readFileSync(path.join(directory, 'photos', 'ExistingPhotos', 'memory.jpg'), 'utf8'), 'original');
});


test('case-variant existing folders consolidate without overwriting colliding filenames', async () => {
  mkdirSync(path.join(directory, 'photos', 'CaseDuplicate'));
  mkdirSync(path.join(directory, 'photos', 'caseduplicate'));
  writeFileSync(path.join(directory, 'photos', 'CaseDuplicate', 'same.jpg'), 'first original');
  writeFileSync(path.join(directory, 'photos', 'caseduplicate', 'same.jpg'), 'second original');
  const member = (await auth.createMember('CaseDuplicate')).member;
  assert.equal(member.folder, 'CaseDuplicate');
  assert.equal(existsSync(path.join(directory, 'photos', 'caseduplicate')), false);
  assert.equal(readFileSync(path.join(directory, 'photos', 'CaseDuplicate', 'same.jpg'), 'utf8'), 'first original');
  assert.equal(readFileSync(path.join(directory, 'photos', 'CaseDuplicate', 'same (2).jpg'), 'utf8'), 'second original');
});

test('shared-link joins claim existing folders regardless of capitalization', async () => {
  mkdirSync(path.join(directory, 'photos', 'UppercaseGuest'));
  const token = auth.createShareLink();
  const joined = (await auth.joinCollection(token, 'UppercaseGuest'));
  assert.equal(joined.member.folder, 'UppercaseGuest');
});

test('upload receipts survive a database reopen, reject mismatches, and are scoped to owner and collection', async () => {
  const { member } = (await auth.createMember('Receipt owner'));
  const scope = auth.uploadScope(member, 'stable-upload-identifier');
  const photo = { id: 'photo-id', name: 'saved.png', folder: member.folder, owner: member.name, width: 20, height: 20, bytes: 12, modifiedAt: new Date().toISOString(), previewStatus: 'pending' as const };
  assert.equal(auth.readUploadReceipt(scope, 'fingerprint'), null);
  auth.writeUploadReceipt(scope, 'fingerprint', photo);
  assert.deepEqual(auth.readUploadReceipt(scope, 'fingerprint'), photo);
  assert.throws(() => auth.readUploadReceipt(scope, 'different'), /another file/);
  assert.notEqual(auth.uploadScope({ ...member, id: 'other-owner' }, 'stable-upload-identifier'), scope);
  const previousRoot = process.env.PHOTO_ROOT;
  try {
    process.env.PHOTO_ROOT = path.join(directory, 'other-collection');
    assert.notEqual(auth.uploadScope(member, 'stable-upload-identifier'), scope);
  } finally { process.env.PHOTO_ROOT = previousRoot; }
  const snapshot = new Database(path.join(directory, 'data/auth.sqlite'), { readonly: true });
  try { assert.equal(JSON.parse((snapshot.prepare('SELECT photo FROM upload_receipts WHERE scope = ?').get(scope) as { photo: string }).photo).id, photo.id); }
  finally { snapshot.close(); }
});

test('duplicate names cannot be introduced by admin creation or renaming', async () => {
  const member = (await auth.createMember('Unique person')).member;
  (await assert.rejects(async () => (await auth.createMember(' UNIQUE PERSON ')), /already belongs/));
  const other = (await auth.createMember('Other unique')).member;
  (await assert.rejects(async () => (await auth.renameMember(other.id, 'unique PERSON')), /already belongs/));
  assert.equal((await auth.renameMember(member.id, 'UNIQUE PERSON')).id, member.id);
});
test('claiming a personal identity through a shared link keeps invitation revocation independent', async () => {
  const person = (await auth.createMember('Claimed person'));
  const personal = auth.exchangeInvite(person.token)!;
  const link = auth.rotateShareLink();
  const claimed = (await auth.joinCollection(link, 'CLAIMED PERSON'));
  assert.equal(claimed.member.id, person.member.id);
  auth.rotateShareLink();
  assert.equal(auth.getSession(claimed.sessionToken), null);
  assert.equal(auth.getSession(personal.sessionToken)?.id, person.member.id);
  auth.revokeMember(person.member.folder);
  assert.equal(auth.getSession(personal.sessionToken), null);
});

test('folder rename preserves sessions, recovery scopes, receipts, checksums and download versions', async () => {
  const { member, token } = await auth.createMember('rename source');
  const session = auth.exchangeInvite(token)!;
  const relative = `${member.folder}/original.jpg`;
  writeFileSync(path.join(directory, 'photos', relative), 'unchanged original');
  const { statSync } = await import('node:fs');
  const { fileRevision } = await import('../src/lib/server/photo-version');
  const revision = fileRevision(process.env.PHOTO_ROOT!, relative, statSync(path.join(process.env.PHOTO_ROOT!, relative)));
  const photo = { id: Buffer.from(relative).toString('base64url'), revision, name: 'original.jpg', folder: member.folder, owner: member.name, width: 20, height: 20, bytes: 18, modifiedAt: new Date().toISOString(), previewStatus: 'pending' as const };
  const scope = auth.uploadScope(member, 'pending-upload');
  auth.writeUploadReceipt(scope, 'fingerprint', photo);
  auth.writeFileChecksum(relative, revision, 'cached-hash');
  auth.recordDownloadedPhotos(member, [photo]);
  const ticket = auth.createDownloadTicket(member, { ids: [photo.id], folders: [member.folder.toLowerCase()] });
  const renamed = await auth.renameMember(member.id, 'renamed person');
  assert.equal(renamed.folder, 'Renamed person');
  assert.equal(auth.getSession(session.sessionToken)?.folder, renamed.folder);
  assert.equal(auth.uploadScope(renamed, 'pending-upload'), scope);
  assert.equal(existsSync(path.join(process.env.PHOTO_ROOT!, member.folder)), false);
  const nextRelative = `${renamed.folder}/original.jpg`;
  const nextRevision = fileRevision(process.env.PHOTO_ROOT!, nextRelative, statSync(path.join(process.env.PHOTO_ROOT!, nextRelative)));
  const receipt = auth.readUploadReceipt(scope, 'fingerprint')!;
  assert.equal(Buffer.from(receipt.id, 'base64url').toString(), nextRelative);
  assert.equal(receipt.owner, renamed.name); assert.equal(receipt.revision, nextRevision);
  assert.equal(auth.readFileChecksum(nextRelative, nextRevision), 'cached-hash');
  assert.equal(auth.downloadedPhotos(renamed).get(receipt.id), nextRevision);
  assert.deepEqual(auth.takeDownloadTicket(renamed, ticket), { ids: [receipt.id], folders: [renamed.folder.toLowerCase()] });
  assert.equal(readFileSync(path.join(process.env.PHOTO_ROOT!, nextRelative), 'utf8'), 'unchanged original');
  const database = auth.memberDatabase();
  assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE name='member_folders'").get(), undefined);
});

test('renames reject concurrent file writes and release queued writes into the new folder', async () => {
  const { member } = await auth.createMember('locked source');
  const { withContributorFiles, withContributorRename } = await import('../src/lib/server/contributor-lock');
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const writing = withContributorFiles(member.id, () => blocked);
  await assert.rejects(auth.renameMember(member.id, 'locked target'), /Finish your current uploads/);
  release(); await writing;
  const renamed = await auth.renameMember(member.id, 'locked target');
  assert.equal(renamed.folder, 'Locked target');
  let resume!: () => void;
  const renaming = withContributorRename(member.id, () => new Promise<void>(resolve => { resume = resolve; }));
  let entered = false;
  const queued = withContributorFiles(member.id, async () => { entered = true; });
  assert.equal(entered, false); resume(); await Promise.all([renaming, queued]); assert.equal(entered, true);
});


test('Unicode capitalization cannot claim another contributor folder', async () => {
  await auth.createMember('ss');
  const member = (await auth.createMember('different Unicode person')).member;
  await assert.rejects(auth.renameMember(member.id, 'ß'), /already belongs/);
  await assert.rejects(auth.createMember('ß'), /already has a contributor/);
});
