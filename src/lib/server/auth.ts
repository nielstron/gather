import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, rmdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { collectionDataRoot } from './settings';
import { config } from './config';
import type { Member, Photo } from '../types';

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
    CREATE TABLE IF NOT EXISTS member_folders (
      folder TEXT PRIMARY KEY COLLATE NOCASE,
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
    if (!columns.has('merged_into')) database.exec('ALTER TABLE members ADD COLUMN merged_into TEXT');
    const sessionColumns = new Set((database.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map(column => column.name));
    if (!sessionColumns.has('shared')) {
      database.exec('ALTER TABLE sessions ADD COLUMN shared INTEGER NOT NULL DEFAULT 0');
      database.exec('UPDATE sessions SET shared = 1 WHERE member_id IN (SELECT id FROM members WHERE shared = 1)');
    }
    // Preserve legacy folders, invitation tokens and sessions while presenting one identity per name.
    const members = database.prepare('SELECT * FROM members WHERE merged_into IS NULL ORDER BY active DESC, shared, created_at, rowid').all() as (Member & { active: number; shared: number })[];
    const byName = new Map<string, Member>();
    for (const member of members) {
      const key = nameKey(member.name), canonical = byName.get(key);
      if (!canonical) { byName.set(key, member); continue; }
      database.prepare('UPDATE members SET merged_into = ? WHERE id = ? OR merged_into = ?').run(canonical.id, member.id, member.id);
      database.prepare('UPDATE member_folders SET member_id = ? WHERE member_id = ?').run(canonical.id, member.id);
      database.prepare(`INSERT OR IGNORE INTO download_history SELECT ?, photo_id, revision, downloaded_at FROM download_history WHERE scope = ?`).run(uploadScope(canonical, 'downloads'), uploadScope(member, 'downloads'));
    }
    // Existing named directories belong with that contributor, including directories predating Gather.
    const claimed = new Set((database.prepare('SELECT folder FROM members UNION SELECT folder FROM member_folders').all() as { folder: string }[]).map(row => nameKey(row.folder)));
    const entries = (existsSync(config.photoRoot) ? readdirSync(config.photoRoot, { withFileTypes: true }) : []).filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.'));
    for (const entry of entries) {
      if (claimed.has(nameKey(entry.name))) continue;
      const member = byName.get(nameKey(entry.name)) || [...byName.values()].find(member => folderSlug(member.name) === nameKey(entry.name));
      if (member) database.prepare('INSERT OR IGNORE INTO member_folders VALUES (?, ?)').run(entry.name, member.id);
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

function nameKey(name: string) { return name.normalize('NFKC').trim().toLowerCase(); }
function folderSlug(name: string) { return name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '') || 'friend'; }
function memberNamed(name: string, except?: string) { return listMembers().find(member => member.id !== except && nameKey(member.name) === nameKey(name)); }
function validateName(name: string) {
  name = name.normalize('NFKC').trim();
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new AuthError(400, 'Display name must contain 1–80 characters and no control characters.');
  }
  return name;
}

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

function validateFolder(folder: string) {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,46}[A-Za-z0-9])?$/.test(folder)) {
    throw new Error('Folder must be 1–48 letters, digits, or hyphens, starting and ending with a letter or digit.');
  }
}

function findMember(folder: string): Member {
  validateFolder(folder);
  const member = db().prepare('SELECT owner.id, owner.name, owner.folder FROM members source JOIN members owner ON owner.id = COALESCE(source.merged_into, source.id) WHERE source.folder = ? COLLATE NOCASE').get(folder) as Member | undefined;
  if (!member) throw new Error(`No member exists for folder "${folder}".`);
  return member;
}

/** Includes revoked members so photos retain their contributor names. */
export function listMembers(): Member[] {
  const database = db();
  const members = database.prepare('SELECT id, name, folder FROM members WHERE merged_into IS NULL ORDER BY name COLLATE NOCASE, folder').all() as Member[];
  const aliases = database.prepare('SELECT folder, merged_into AS member_id FROM members WHERE merged_into IS NOT NULL UNION ALL SELECT folder, member_id FROM member_folders').all() as { folder: string; member_id: string }[];
  return members.map(member => { const folders = aliases.filter(row => row.member_id === member.id).map(row => row.folder); return folders.length ? { ...member, folders } : member; });
}

export function createMember(name: string, folder: string): { member: Member; token: string } {
  validateFolder(folder);
  name = validateName(name);
  if (memberNamed(name)) throw new AuthError(409, 'This name already belongs to a contributor. Use their existing invitation.');
  if (db().prepare('SELECT id FROM members WHERE folder = ? COLLATE NOCASE UNION ALL SELECT member_id AS id FROM member_folders WHERE folder = ? COLLATE NOCASE').get(folder, folder)) {
    throw new Error(`Folder "${folder}" already has a member. Create a replacement invitation for this member instead.`);
  }
  mkdirSync(config.photoRoot, { recursive: true });
  // Match the filesystem's spelling while treating capitalization as equivalent.
  // Names alone never select a folder: this applies only to the admin's folder input.
  const matches = readdirSync(config.photoRoot).filter(entry => entry.toLowerCase() === folder.toLowerCase());
  if (matches.length > 1) throw new Error('Multiple folders differ only in capitalization. Combine or rename those folders before assigning a personal invitation.');
  folder = matches[0] || folder;
  const destination = path.join(config.photoRoot, folder);
  try {
    mkdirSync(destination, { mode: 0o750 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const directory = lstatSync(destination);
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new Error('The member folder must be a real directory, not a symbolic link.');
  }
  const member = { id: randomUUID(), name, folder };
  const token = newToken();
  db().prepare('INSERT INTO members (id, name, folder, invite_hash, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(member.id, member.name, member.folder, hash(token), Date.now());
  return { member, token };
}

/** Replaces the invitation and signs out every existing session for this member. */
export function rotateMember(folder: string): { member: Member; token: string } {
  const member = findMember(folder);
  const token = newToken();
  db().transaction(() => {
    db().prepare('UPDATE members SET invite_hash = NULL, active = 0 WHERE merged_into = ?').run(member.id);
    db().prepare('UPDATE members SET invite_hash = ?, active = 1, shared = 0 WHERE id = ?').run(hash(token), member.id);
    db().prepare('DELETE FROM sessions WHERE member_id IN (SELECT id FROM members WHERE id = ? OR merged_into = ?)').run(member.id, member.id);
  })();
  return { member, token };
}

/** Keeps originals and contributor attribution; only access is revoked. */
export function revokeMember(folder: string): void {
  const member = findMember(folder);
  db().transaction(() => {
    db().prepare('UPDATE members SET invite_hash = NULL, active = 0 WHERE id = ? OR merged_into = ?').run(member.id, member.id);
    db().prepare('DELETE FROM sessions WHERE member_id IN (SELECT id FROM members WHERE id = ? OR merged_into = ?)').run(member.id, member.id);
  })();
}

export function exchangeInvite(token: string): { member: Member; sessionToken: string } | null {
  if (!tokenPattern.test(token)) return null;
  return db().transaction(() => {
    const member = db().prepare('SELECT owner.id, owner.name, owner.folder FROM members source JOIN members owner ON owner.id = COALESCE(source.merged_into, source.id) WHERE source.invite_hash = ? AND source.active = 1 AND owner.active = 1').get(hash(token)) as Member | undefined;
    if (!member) return null;
    // A reusable invitation supports multiple devices without unbounded session storage.
    return createSession(member);
  })();
}

export function getSession(token: string | undefined): Member | null {
  if (!token || !tokenPattern.test(token)) return null;
  return (db().prepare(`SELECT owner.id, owner.name, owner.folder
    FROM sessions JOIN members ON members.id = sessions.member_id JOIN members owner ON owner.id = COALESCE(members.merged_into, members.id)
    WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND members.active = 1 AND owner.active = 1`)
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
export function joinCollection(token: string, name: string): { member: Member; sessionToken: string } {
  name = validateName(name);
  if (!tokenPattern.test(token)) throw new AuthError(401, 'This shared link is invalid or has been revoked. Ask your host for the current link.');
  return db().transaction(() => {
    if (!db().prepare('SELECT id FROM shared_link WHERE id = 1 AND token_hash = ?').get(hash(token))) {
      throw new AuthError(401, 'This shared link is invalid or has been revoked. Ask your host for the current link.');
    }
    mkdirSync(config.photoRoot, { recursive: true });
    const root = lstatSync(config.photoRoot);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('The photo root must be a real directory.');
    const slug = folderSlug(name);
    const existing = memberNamed(name) || listMembers().find(member => [member.folder, ...(member.folders || [])].some(folder => nameKey(folder) === nameKey(name) || nameKey(folder) === slug));
    if (existing) {
      const status = db().prepare('SELECT active, shared FROM members WHERE id = ?').get(existing.id) as { active: number; shared: number };
      if (!status.active && !status.shared) throw new AuthError(409, 'This contributor was revoked. Ask the host to restore their invitation.');
      db().prepare('UPDATE members SET active = 1 WHERE id = ?').run(existing.id);
      return createSession({ id: existing.id, name: existing.name, folder: existing.folder }, true);
    }
    const matches = readdirSync(config.photoRoot).filter(folder => nameKey(folder) === nameKey(name) || nameKey(folder) === slug);
    if (matches.length > 1) throw new AuthError(409, 'Several folders match this name. Ask the host to assign the correct folder.');
    let folder = matches[0] || '';
    let created = false;
    if (folder) {
      const destination = lstatSync(path.join(config.photoRoot, folder));
      if (!destination.isDirectory() || destination.isSymbolicLink() || folder.startsWith('.')) throw new AuthError(409, 'This name does not match a shareable folder.');
    } else {
      const claimed = new Set(listMembers().flatMap(member => [member.folder, ...(member.folders || [])]).map(nameKey));
      for (let attempt = 0; attempt < 10; attempt++) {
        const candidate = attempt === 0 ? slug : `${slug}-${randomUUID().slice(0, 8)}`;
        if (claimed.has(nameKey(candidate))) continue;
        try { mkdirSync(path.join(config.photoRoot, candidate), { mode: 0o750 }); folder = candidate; created = true; break; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      }
    }
    if (!folder) throw new AuthError(409, 'Could not create a personal folder. Please try joining again.');
    try {
      const member = { id: randomUUID(), name, folder };
      db().prepare('INSERT INTO members (id, name, folder, invite_hash, created_at, active, shared) VALUES (?, ?, ?, NULL, ?, 1, 1)')
        .run(member.id, member.name, member.folder, Date.now());
      return createSession(member, true);
    } catch (error) {
      try { if (created) rmdirSync(path.join(config.photoRoot, folder)); } catch { /* Preserve any externally added files. */ }
      throw error;
    }
  }).immediate();
}

export function renameMember(id: string, name: string): Member {
  name = validateName(name);
  if (memberNamed(name, id)) throw new AuthError(409, 'This name already belongs to another contributor.');
  const result = db().prepare('UPDATE members SET name = ? WHERE id = ? AND active = 1').run(name, id);
  if (!result.changes) throw new AuthError(401, 'Your session is no longer active. Open the shared link to join again.');
  return db().prepare('SELECT id, name, folder FROM members WHERE id = ?').get(id) as Member;
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
    members: db().prepare('SELECT id, name, folder, active, shared FROM members WHERE merged_into IS NULL ORDER BY name COLLATE NOCASE').all()
  };
}


const receiptLifetime = 7 * 86400_000;
export function uploadScope(member: Member, key: string) {
  return hash(JSON.stringify([config.photoRoot, member.id, member.folder, key]));
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
