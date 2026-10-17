import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
after(() => rmSync(directory, { recursive: true, force: true }));

test('legacy database migration preserves live sessions without restoring revoked users', () => {
  assert.equal(auth.getSession('L'.repeat(43))?.folder, 'legacy-live');
  assert.equal(auth.getSession('R'.repeat(43)), null);
});

test('invitations create independent sessions and only hashes are stored', () => {
  const { member, token } = auth.createMember('Alice', 'alice');
  assert.equal(token.length, 43);
  assert.equal(member.folder, 'alice');
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

test('rotation and revocation invalidate old invitations and every session', () => {
  const original = auth.createMember('Bea', 'bea');
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
  assert.throws(() => auth.createMember('Another Bea', 'bea'), /already has a member/);
});

test('sessions expire and malformed tokens fail safely', () => {
  const { token } = auth.createMember('Charlie', 'charlie');
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

test('member folder names cannot escape the photo root or claim another member', () => {
  for (const folder of ['../escape', 'alice/other', '/tmp', '.', '..', 'Alice', '-alice', 'a'.repeat(49)]) {
    assert.throws(() => auth.createMember('Test', folder), /Folder must/);
  }
  assert.throws(() => auth.createMember('Duplicate', 'alice'), /already has a member/);
  assert.throws(() => auth.createMember('  ', 'invalid-name'), /Display name/);
  symlinkSync(directory, path.join(directory, 'photos', 'symlink'));
  assert.throws(() => auth.createMember('Symlink', 'symlink'), /real directory/);
});

test('reusable invitations retain only a bounded number of sessions', () => {
  const { token } = auth.createMember('Drew', 'drew');
  const oldest = auth.exchangeInvite(token)!;
  let newest = oldest;
  for (let index = 0; index < 25; index++) newest = auth.exchangeInvite(token)!;
  assert.equal(auth.getSession(oldest.sessionToken), null);
  assert.equal(auth.getSession(newest.sessionToken)?.folder, 'drew');
});

test('a shared link stores only its hash and same-name visitors get separate folders', () => {
  const token = auth.createShareLink();
  assert.equal(token.length, 43);
  assert.throws(() => auth.createShareLink(), /already exists/);
  const first = auth.joinCollection(token, 'Alex');
  const second = auth.joinCollection(token, 'Alex');
  assert.equal(first.member.name, second.member.name);
  assert.notEqual(first.member.id, second.member.id);
  assert.notEqual(first.member.folder, second.member.folder);
  assert.deepEqual(auth.getSession(first.sessionToken), first.member);
  assert.deepEqual(auth.getSession(second.sessionToken), second.member);
  const collision = auth.joinCollection(token, 'Alice');
  assert.notEqual(collision.member.folder, 'alice');
  mkdirSync(path.join(directory, 'photos', 'existing'));
  writeFileSync(path.join(directory, 'photos', 'existing', 'keep.txt'), 'existing files');
  assert.notEqual(auth.joinCollection(token, 'Existing').member.folder, 'existing');
  const unicode = auth.joinCollection(token, '日本語');
  assert.match(unicode.member.folder, /^[a-z0-9-]+$/);
  const db = new Database(path.join(directory, 'data/auth.sqlite'), { readonly: true });
  const row = db.prepare('SELECT token_hash FROM shared_link WHERE id = 1').get() as { token_hash: string };
  assert.equal(row.token_hash, createHash('sha256').update(token).digest('hex'));
  db.close();
});

test('shared link rotation and revocation invalidate shared sessions, preserving personal access and photos', () => {
  const personal = auth.createMember('Private member', 'private-member');
  const personalSession = auth.exchangeInvite(personal.token)!;
  const originalToken = auth.rotateShareLink();
  const shared = auth.joinCollection(originalToken, 'Shared Friend');
  const filename = path.join(directory, 'photos', shared.member.folder, 'photo.jpg');
  writeFileSync(filename, 'original bytes');
  const replacement = auth.rotateShareLink();
  assert.notEqual(replacement, originalToken);
  assert.equal(auth.getSession(shared.sessionToken), null);
  assert.throws(() => auth.joinCollection(originalToken, 'Someone'), (error: unknown) => error instanceof auth.AuthError && error.status === 401);
  assert.deepEqual(auth.getSession(personalSession.sessionToken), personal.member);
  const newest = auth.joinCollection(replacement, 'Shared Friend');
  auth.revokeShareLink();
  assert.equal(auth.getSession(newest.sessionToken), null);
  assert.throws(() => auth.joinCollection(replacement, 'Someone'), /revoked/);
  assert.deepEqual(auth.getSession(personalSession.sessionToken), personal.member);
  assert.equal(readFileSync(filename, 'utf8'), 'original bytes');
  assert.ok(auth.listMembers().some((member) => member.id === shared.member.id));
});

test('changing a display name preserves the identity, session, folder, and existing files', () => {
  const token = auth.createShareLink();
  const joined = auth.joinCollection(token, 'Before Name');
  const filename = path.join(directory, 'photos', joined.member.folder, 'photo.jpg');
  writeFileSync(filename, 'keep my photos');
  const renamed = auth.renameMember(joined.member.id, '  After Name  ');
  assert.equal(renamed.name, 'After Name');
  assert.equal(renamed.id, joined.member.id);
  assert.equal(renamed.folder, joined.member.folder);
  assert.deepEqual(auth.getSession(joined.sessionToken), renamed);
  assert.equal(readFileSync(filename, 'utf8'), 'keep my photos');
  for (const name of ['', '   ', 'a'.repeat(81), 'bad\nname']) {
    assert.throws(() => auth.renameMember(joined.member.id, name), /Display name/);
    assert.throws(() => auth.joinCollection(token, name), /Display name/);
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
  assert.equal((await profile.json()).user.folder, joined.folder);
  assert.equal(auth.getSession(session)?.name, 'API Renamed');
  const oversized = await POST({
    request: new Request('http://localhost/api/join', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, name: 'x'.repeat(2048) }) }),
    cookies, getClientAddress: () => 'auth-test'
  } as never);
  assert.equal(oversized.status, 400);
});
