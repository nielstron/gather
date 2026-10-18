import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readdirSync, rmdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config';
import type { Member } from '../types';

let database: Database.Database | undefined;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

export class AuthError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function db() {
  if (database) return database;
  mkdirSync(config.dataRoot, { recursive: true, mode: 0o700 });
  const filename = path.join(config.dataRoot, 'auth.sqlite');
  database = new Database(filename);
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
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_member_id ON sessions(member_id);
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
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
  }).immediate();
  return database;
}

function hash(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

function newToken() {
  return randomBytes(32).toString('base64url');
}

function validateName(name: string) {
  name = name.trim();
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new AuthError(400, 'Display name must contain 1–80 characters and no control characters.');
  }
  return name;
}

function createSession(member: Member) {
  const now = Date.now();
  db().prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  db().prepare(`DELETE FROM sessions WHERE member_id = ? AND token_hash NOT IN (
    SELECT token_hash FROM sessions WHERE member_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 19
  )`).run(member.id, member.id);
  const sessionToken = newToken();
  db().prepare('INSERT INTO sessions (token_hash, member_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(hash(sessionToken), member.id, now + config.sessionDays * 86400_000, now);
  return { member, sessionToken };
}

function validateFolder(folder: string) {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,46}[A-Za-z0-9])?$/.test(folder)) {
    throw new Error('Folder must be 1–48 letters, digits, or hyphens, starting and ending with a letter or digit.');
  }
}

function findMember(folder: string): Member {
  validateFolder(folder);
  const member = db().prepare('SELECT id, name, folder FROM members WHERE folder = ? COLLATE NOCASE').get(folder) as Member | undefined;
  if (!member) throw new Error(`No member exists for folder "${folder}".`);
  return member;
}

/** Includes revoked members so photos retain their contributor names. */
export function listMembers(): Member[] {
  return db().prepare('SELECT id, name, folder FROM members ORDER BY name COLLATE NOCASE, folder').all() as Member[];
}

export function createMember(name: string, folder: string): { member: Member; token: string } {
  validateFolder(folder);
  name = validateName(name);
  if (db().prepare('SELECT id FROM members WHERE folder = ? COLLATE NOCASE').get(folder)) {
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
    db().prepare('DELETE FROM sessions WHERE member_id = ?').run(member.id);
  })();
}

export function exchangeInvite(token: string): { member: Member; sessionToken: string } | null {
  if (!tokenPattern.test(token)) return null;
  return db().transaction(() => {
    const member = db().prepare('SELECT id, name, folder FROM members WHERE invite_hash = ? AND active = 1').get(hash(token)) as Member | undefined;
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
    db().prepare('DELETE FROM sessions WHERE member_id IN (SELECT id FROM members WHERE shared = 1)').run();
    db().prepare('UPDATE members SET active = 0 WHERE shared = 1').run();
    return createShareLink();
  }).immediate();
}

export function revokeShareLink(): void {
  db().transaction(() => {
    db().prepare('UPDATE shared_link SET token_hash = NULL, updated_at = ? WHERE id = 1').run(Date.now());
    db().prepare('DELETE FROM sessions WHERE member_id IN (SELECT id FROM members WHERE shared = 1)').run();
    db().prepare('UPDATE members SET active = 0 WHERE shared = 1').run();
  }).immediate();
}

/** A name is a label, never a credential: every join allocates a new upload identity. */
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
    const slug = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '') || 'friend';
    const existingFolders = new Set(readdirSync(config.photoRoot).map(entry => entry.toLowerCase()));
    let folder = '';
    for (let attempt = 0; attempt < 10; attempt++) {
      const candidate = attempt === 0 ? slug : `${slug}-${randomUUID().slice(0, 8)}`;
      if (existingFolders.has(candidate.toLowerCase()) || db().prepare('SELECT id FROM members WHERE folder = ? COLLATE NOCASE').get(candidate)) continue;
      try { mkdirSync(path.join(config.photoRoot, candidate), { mode: 0o750 }); folder = candidate; break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    if (!folder) throw new AuthError(409, 'Could not create a personal folder. Please try joining again.');
    try {
      const member = { id: randomUUID(), name, folder };
      db().prepare('INSERT INTO members (id, name, folder, invite_hash, created_at, active, shared) VALUES (?, ?, ?, NULL, ?, 1, 1)')
        .run(member.id, member.name, member.folder, Date.now());
      return createSession(member);
    } catch (error) {
      try { rmdirSync(path.join(config.photoRoot, folder)); } catch { /* Preserve any externally added files. */ }
      throw error;
    }
  }).immediate();
}

export function renameMember(id: string, name: string): Member {
  name = validateName(name);
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
    members: db().prepare('SELECT id, name, folder, active, shared FROM members ORDER BY name COLLATE NOCASE').all()
  };
}
