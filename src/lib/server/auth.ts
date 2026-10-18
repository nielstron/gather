import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { readSettings, collectionDataRoot } from './settings';
import { config } from './config';
import type { Member, Photo } from '../types';
import { contributorName, contributorFolder, contributorKey } from '../contributor-folder';
import { ensureCanonicalFolders, claimContributorFolder, renameContributorFolder } from './contributor-folders';
import { withMembershipChange } from './contributor-lock';

const databases = new Map<string, Database.Database>();
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

export class AuthError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function db() {
  const filename = path.join(collectionDataRoot(), 'auth.sqlite');
  const known = databases.get(filename);
  if (known) return known;
  mkdirSync(collectionDataRoot(), { recursive: true, mode: 0o700 });
  const database = new Database(filename);
  chmodSync(filename, 0o600);
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE IF NOT EXISTS members (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      invite_hash TEXT UNIQUE,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS member_invites (
      token_hash TEXT PRIMARY KEY,
      member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_member_id ON sessions(member_id);
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS file_checksums (
      scope TEXT PRIMARY KEY,
      revision TEXT NOT NULL,
      checksum TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS upload_receipts (
      scope TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      photo TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS upload_receipts_created ON upload_receipts(created_at);
    CREATE TABLE IF NOT EXISTS download_tickets (
      token_hash TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      choice TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS download_history (
      scope TEXT NOT NULL,
      photo_id TEXT NOT NULL,
      revision TEXT NOT NULL,
      downloaded_at INTEGER NOT NULL,
      PRIMARY KEY (scope, photo_id)
    );
    CREATE TABLE IF NOT EXISTS shared_link (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      token_hash TEXT,
      updated_at INTEGER NOT NULL
    );
  `);
  // Upgrade databases made by the original personal-invitation prototype.
  database.transaction(() => {
    const columns = new Set((database!.prepare('PRAGMA table_info(members)').all() as { name: string }[]).map((column) => column.name));
    if (!columns.has('active')) {
      database!.exec('ALTER TABLE members ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
      database!.exec('UPDATE members SET active = 0 WHERE invite_hash IS NULL');
    }
    if (!columns.has('shared')) database!.exec('ALTER TABLE members ADD COLUMN shared INTEGER NOT NULL DEFAULT 0');
    if (!columns.has('scope_seed')) database.exec("ALTER TABLE members ADD COLUMN scope_seed TEXT NOT NULL DEFAULT ''");
    const sessionColumns = new Set((database.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map(column => column.name));
    if (!sessionColumns.has('shared')) {
      database.exec('ALTER TABLE sessions ADD COLUMN shared INTEGER NOT NULL DEFAULT 0');
      database.exec('UPDATE sessions SET shared = 1 WHERE member_id IN (SELECT id FROM members WHERE shared = 1)');
    }
  }).immediate();
  databases.set(filename, database);
  return database;
}

function hash(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

function newToken() {
  return randomBytes(32).toString('base64url');
}

const nameKey = contributorKey;
function memberNamed(name: string, except?: string) { return listMembers().find(member => member.id !== except && nameKey(member.name) === nameKey(name)); }
function validateName(name: string) {
  try { return contributorName(name); }
  catch (error) { throw new AuthError(400, `Display name: ${(error as Error).message}`); }
}

export function memberDatabase() { return db(); }

function createSession(member: Member, shared = false) {
  const now = Date.now();
  db().prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  db().prepare(`DELETE FROM sessions WHERE member_id = ? AND token_hash NOT IN (
    SELECT token_hash FROM sessions WHERE member_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 19
  )`).run(member.id, member.id);
  const sessionToken = newToken();
  db().prepare('INSERT INTO sessions (token_hash, member_id, expires_at, created_at, shared) VALUES (?, ?, ?, ?, ?)')
    .run(hash(sessionToken), member.id, now + config.sessionDays * 86400_000, now, Number(shared));
  return { member, sessionToken };
}

function findMember(folder: string): Member {
  const member = listMembers().find(person => nameKey(person.folder) === nameKey(folder));
  if (!member) throw new Error(`No member exists for folder "${folder}".`);
  return member;
}

/** One row and one canonical directory per contributor, including revoked identities. */
export function listMembers(): Member[] {
  const database = db();
  const legacy = (database.prepare('PRAGMA table_info(members)').all() as { name: string }[]).some(column => column.name === 'merged_into');
  return database.prepare(`SELECT id, name, folder FROM members ${legacy ? 'WHERE merged_into IS NULL' : ''} ORDER BY name COLLATE NOCASE, folder`).all() as Member[];
}

export async function createMember(name: string): Promise<{ member: Member; token: string }> {
  await ensureCanonicalFolders();
  return withMembershipChange(async () => {
    name = validateName(name);
    if (memberNamed(name)) throw new AuthError(409, 'This name already belongs to a contributor. Use their existing invitation.');
    const folder = contributorFolder(name);
    if (listMembers().some(member => nameKey(member.folder) === nameKey(folder))) throw new AuthError(409, 'This folder already has a contributor.');
    await claimContributorFolder(folder);
    const member = { id: randomUUID(), name, folder }, token = newToken();
    db().prepare('INSERT INTO members (id,name,folder,invite_hash,created_at,scope_seed) VALUES (?,?,?,?,?,?)').run(member.id, name, folder, hash(token), Date.now(), folder);
    return { member, token };
  });
}

/** Replaces the invitation and signs out every existing session for this member. */
export function rotateMember(folder: string): { member: Member; token: string } {
  const member = findMember(folder);
  const token = newToken();
  db().transaction(() => {
    db().prepare('DELETE FROM member_invites WHERE member_id = ?').run(member.id);
    db().prepare('UPDATE members SET invite_hash = ?, active = 1, shared = 0 WHERE id = ?').run(hash(token), member.id);
    db().prepare('DELETE FROM sessions WHERE member_id = ?').run(member.id);
  })();
  return { member, token };
}

/** Keeps originals and contributor attribution; only access is revoked. */
export function revokeMember(folder: string): void {
  const member = findMember(folder);
  db().transaction(() => {
    db().prepare('UPDATE members SET invite_hash = NULL, active = 0 WHERE id = ?').run(member.id);
    db().prepare('DELETE FROM member_invites WHERE member_id = ?').run(member.id);
    db().prepare('DELETE FROM sessions WHERE member_id = ?').run(member.id);
  })();
}

export function exchangeInvite(token: string): { member: Member; sessionToken: string } | null {
  if (!tokenPattern.test(token)) return null;
  return db().transaction(() => {
    const member = db().prepare('SELECT id,name,folder FROM members WHERE active=1 AND (invite_hash=? OR id IN (SELECT member_id FROM member_invites WHERE token_hash=?))').get(hash(token), hash(token)) as Member | undefined;
    if (!member) return null;
    // A reusable invitation supports multiple devices without unbounded session storage.
    return createSession(member);
  })();
}

export function getSession(token: string | undefined): Member | null {
  if (!token || !tokenPattern.test(token)) return null;
  return (db().prepare(`SELECT members.id, members.name, members.folder
    FROM sessions JOIN members ON members.id = sessions.member_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND members.active = 1`)
    .get(hash(token), Date.now()) as Member | undefined) ?? null;
}

export function deleteSession(token: string | undefined): void {
  if (token && tokenPattern.test(token)) db().prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash(token));
}

export function createShareLink(): string {
  return db().transaction(() => {
    const existing = db().prepare('SELECT token_hash FROM shared_link WHERE id = 1').get() as { token_hash: string | null } | undefined;
    if (existing?.token_hash) throw new Error('A shared link already exists. Its token cannot be recovered. Replace it in People & invitations to create a new link and sign out shared-link visitors.');
    const token = newToken();
    db().prepare('INSERT INTO shared_link (id, token_hash, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET token_hash = excluded.token_hash, updated_at = excluded.updated_at')
      .run(hash(token), Date.now());
    return token;
  }).immediate();
}

export function rotateShareLink(): string {
  return db().transaction(() => {
    db().prepare('UPDATE shared_link SET token_hash = NULL, updated_at = ? WHERE id = 1').run(Date.now());
    db().prepare('DELETE FROM sessions WHERE shared = 1 OR member_id IN (SELECT id FROM members WHERE shared = 1)').run();
    db().prepare('UPDATE members SET active = 0 WHERE shared = 1').run();
    return createShareLink();
  }).immediate();
}

export function revokeShareLink(): void {
  db().transaction(() => {
    db().prepare('UPDATE shared_link SET token_hash = NULL, updated_at = ? WHERE id = 1').run(Date.now());
    db().prepare('DELETE FROM sessions WHERE shared = 1 OR member_id IN (SELECT id FROM members WHERE shared = 1)').run();
    db().prepare('UPDATE members SET active = 0 WHERE shared = 1').run();
  }).immediate();
}

/** A valid collection link permits claiming the existing contributor with this name. */
export async function joinCollection(token: string, name: string): Promise<{ member: Member; sessionToken: string }> {
  await ensureCanonicalFolders();
  return withMembershipChange(async () => {
    name = validateName(name);
    if (!tokenPattern.test(token) || !db().prepare('SELECT id FROM shared_link WHERE id=1 AND token_hash=?').get(hash(token))) throw new AuthError(401, 'This shared link is invalid or has been revoked. Ask your host for the current link.');
    const existing = memberNamed(name);
    if (existing) {
      const status = db().prepare('SELECT active, shared FROM members WHERE id=?').get(existing.id) as { active: number; shared: number };
      if (!status.active && !status.shared) throw new AuthError(409, 'This contributor was revoked. Ask the host to restore their invitation.');
      db().prepare('UPDATE members SET active=1 WHERE id=?').run(existing.id);
      return createSession(existing, true);
    }
    const folder = contributorFolder(name);
    if (listMembers().some(person => nameKey(person.folder) === nameKey(folder))) throw new AuthError(409, 'This folder already has a contributor.');
    await claimContributorFolder(folder);
    const member = { id: randomUUID(), name, folder };
    db().prepare('INSERT INTO members (id,name,folder,invite_hash,created_at,active,shared,scope_seed) VALUES (?,?,?,NULL,?,1,1,?)').run(member.id, name, folder, Date.now(), folder);
    return createSession(member, true);
  });
}

export async function renameMember(id: string, name: string): Promise<Member> {
  await ensureCanonicalFolders();
  return withMembershipChange(async () => {
    name = validateName(name);
    if (memberNamed(name, id) || listMembers().some(member => member.id !== id && nameKey(member.folder) === nameKey(contributorFolder(name)))) throw new AuthError(409, 'This name already belongs to another contributor.');
    const member = db().prepare('SELECT id,name,folder FROM members WHERE id=? AND active=1').get(id) as Member | undefined;
    if (!member) throw new AuthError(401, 'Your session is no longer active. Open the shared link to join again.');
    await renameContributorFolder(member, name);
    return { id, name, folder: contributorFolder(name) };
  });
}

/** Switching collections must never grant existing visitors access to different photos. */
export function resetCollectionAccess() {
  db().transaction(() => {
    db().prepare('DELETE FROM sessions').run();
    db().prepare('DELETE FROM members').run();
    db().prepare('UPDATE shared_link SET token_hash = NULL, updated_at = ? WHERE id = 1').run(Date.now());
  })();
}

export function accessOverview() {
  return {
    sharedLinkActive: !!db().prepare('SELECT id FROM shared_link WHERE id = 1 AND token_hash IS NOT NULL').get(),
    members: db().prepare('SELECT id, name, folder, active, shared FROM members ORDER BY name COLLATE NOCASE').all()
  };
}


const receiptLifetime = 7 * 86400_000;
export function uploadScope(member: Member, key: string) {
  const seed = (db().prepare('SELECT scope_seed FROM members WHERE id=?').get(member.id) as { scope_seed: string } | undefined)?.scope_seed || member.folder;
  return hash(JSON.stringify([config.photoRoot, member.id, seed, key]));
}

export function readUploadReceipt(scope: string, fingerprint: string): Photo | null {
  const receipt = db().prepare('SELECT fingerprint, photo FROM upload_receipts WHERE scope = ? AND created_at > ?').get(scope, Date.now() - receiptLifetime) as { fingerprint: string; photo: string } | undefined;
  if (!receipt) return null;
  if (receipt.fingerprint !== fingerprint) throw new AuthError(409, 'This upload identifier was already used for another file.');
  return JSON.parse(receipt.photo) as Photo;
}

export function writeUploadReceipt(scope: string, fingerprint: string, photo: Photo) {
  db().transaction(() => {
    db().prepare('DELETE FROM upload_receipts WHERE created_at < ?').run(Date.now() - receiptLifetime);
    db().prepare('INSERT OR REPLACE INTO upload_receipts (scope, fingerprint, photo, created_at) VALUES (?, ?, ?, ?)').run(scope, fingerprint, JSON.stringify(photo), Date.now());
  })();
}


export function readFileChecksum(relative: string, revision: string): string | null {
  const scope = hash(JSON.stringify([config.photoRoot, relative]));
  return (db().prepare('SELECT checksum FROM file_checksums WHERE scope = ? AND revision = ?').get(scope, revision) as { checksum: string } | undefined)?.checksum ?? null;
}

export function writeFileChecksum(relative: string, revision: string, checksum: string) {
  const scope = hash(JSON.stringify([config.photoRoot, relative]));
  db().prepare('INSERT OR REPLACE INTO file_checksums (scope, revision, checksum) VALUES (?, ?, ?)').run(scope, revision, checksum);
}


/** Per-member, per-folder versions; a partial download never advances other files. */
export function downloadedPhotos(member: Member): Map<string, string> {
  const rows = db().prepare('SELECT photo_id, revision FROM download_history WHERE scope = ?').all(uploadScope(member, 'downloads')) as { photo_id: string; revision: string }[];
  return new Map(rows.map(row => [row.photo_id, row.revision]));
}
export function recordDownloadedPhotos(member: Member, photos: { id: string; revision?: string }[]) {
  const statement = db().prepare('INSERT OR REPLACE INTO download_history (scope, photo_id, revision, downloaded_at) VALUES (?, ?, ?, ?)');
  const scope = uploadScope(member, 'downloads');
  db().transaction(() => { for (const photo of photos) if (photo.revision) statement.run(scope, photo.id, photo.revision, Date.now()); })();
}

/** Short-lived, single-use recipes keep archive URLs small and scoped to a session member. */
export function createDownloadTicket(member: Member, choice: unknown): string {
  const token = randomBytes(32).toString('base64url');
  const database = db();
  database.prepare('DELETE FROM download_tickets WHERE expires_at < ?').run(Date.now());
  database.prepare('INSERT INTO download_tickets VALUES (?, ?, ?, ?)').run(hash(token), uploadScope(member, 'downloads'), JSON.stringify(choice), Date.now() + 10 * 60_000);
  return token;
}
export function takeDownloadTicket(member: Member, token: string): unknown {
  if (!tokenPattern.test(token)) return;
  const row = db().prepare('DELETE FROM download_tickets WHERE token_hash = ? AND scope = ? AND expires_at > ? RETURNING choice').get(hash(token), uploadScope(member, 'downloads'), Date.now()) as { choice: string } | undefined;
  return row ? JSON.parse(row.choice) : undefined;
}


/** Deleted originals must not be replayed as successful resumable uploads. */
export function forgetDeletedPhotos(photos: { id: string; relative: string }[]) {
  const database = db();
  const receipt = database.prepare("DELETE FROM upload_receipts WHERE json_extract(photo, '$.id') = ?");
  const checksum = database.prepare('DELETE FROM file_checksums WHERE scope = ?');
  database.transaction(() => {
    for (const photo of photos) {
      receipt.run(photo.id);
      checksum.run(hash(JSON.stringify([config.photoRoot, photo.relative])));
    }
  })();
}
