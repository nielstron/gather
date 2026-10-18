import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { dataRoot, readSettings, type Settings } from './settings';

let database: Database.Database | undefined;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function db() {
  if (database) return database;
  mkdirSync(dataRoot(), { recursive: true, mode: 0o700 });
  const filename = path.join(dataRoot(), 'admin.sqlite');
  database = new Database(filename);
  chmodSync(filename, 0o600);
  database.pragma('journal_mode = WAL');
  database.exec(`CREATE TABLE IF NOT EXISTS administrator (id INTEGER PRIMARY KEY CHECK(id = 1), salt TEXT NOT NULL, password_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);`);
  return database;
}

export function adminConfigured() { return !!db().prepare('SELECT id FROM administrator WHERE id = 1').get(); }

/** Provisioning token is accessible only through the server's private data directory. */
export function ensureSetupToken() {
  if (adminConfigured()) return;
  const filename = path.join(dataRoot(), 'admin-setup-token');
  if (!existsSync(filename)) {
    writeFileSync(filename, randomBytes(32).toString('base64url'), { mode: 0o600, flag: 'wx' });
  }
}

export function setupAdmin(token: string, password: string) {
  ensureSetupToken();
  if (adminConfigured()) throw Object.assign(new Error('The administrator is already configured. Sign in instead.'), { status: 409 });
  if (!tokenPattern.test(token)) throw Object.assign(new Error('Invalid setup token. Open the private setup link.'), { status: 401 });
  const expected = readFileSync(path.join(dataRoot(), 'admin-setup-token'), 'utf8').trim();
  if (!timingSafeEqual(Buffer.from(hash(token)), Buffer.from(hash(expected)))) throw Object.assign(new Error('Invalid setup token. Open the private setup link.'), { status: 401 });
  if (password.length < 12 || password.length > 256) throw Object.assign(new Error('Choose a password between 12 and 256 characters.'), { status: 400 });
  const salt = randomBytes(16).toString('hex');
  db().prepare('INSERT INTO administrator VALUES (1, ?, ?)').run(salt, scryptSync(password, salt, 64).toString('hex'));
  unlinkSync(path.join(dataRoot(), 'admin-setup-token'));
  return newSession();
}

function newSession() {
  const token = randomBytes(32).toString('base64url');
  db().prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  db().prepare('INSERT INTO sessions VALUES (?, ?)').run(hash(token), Date.now() + 12 * 3600_000);
  return token;
}

export function loginAdmin(password: string) {
  const row = db().prepare('SELECT salt, password_hash FROM administrator WHERE id = 1').get() as { salt: string; password_hash: string } | undefined;
  const computed = scryptSync(password.slice(0, 256), row?.salt || 'unconfigured', 64);
  if (!row || password.length > 256 || !timingSafeEqual(computed, Buffer.from(row.password_hash, 'hex'))) {
    throw Object.assign(new Error('Incorrect administrator password.'), { status: 401 });
  }
  return newSession();
}

export function getAdminSession(token: string | undefined): boolean {
  if (!token || !tokenPattern.test(token)) return false;
  return !!db().prepare('SELECT token_hash FROM sessions WHERE token_hash = ? AND expires_at > ?').get(hash(token), Date.now());
}

export function logoutAdmin(token: string | undefined) {
  if (token) db().prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash(token));
}

export function allowedPhotoRoot() {
  const root = path.resolve(process.env.PHOTO_ALLOWED_ROOT || process.env.PHOTO_ROOT || './var/photos');
  mkdirSync(root, { recursive: true });
  return realpathSync(root);
}

export function validatePhotoRoot(value: string) {
  const root = allowedPhotoRoot();
  const candidate = path.resolve(value);
  const relative = path.relative(root, candidate);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw Object.assign(new Error('Choose a folder within the mounted photo directory.'), { status: 400 });
  let current = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    if (lstatSync(current).isSymbolicLink()) throw Object.assign(new Error('Symbolic-link folders cannot be shared.'), { status: 400 });
  }
  if (!lstatSync(candidate).isDirectory()) throw Object.assign(new Error('Choose an existing directory.'), { status: 400 });
  const data = path.relative(candidate, dataRoot());
  if (!data || (data !== '..' && !data.startsWith('..' + path.sep) && !path.isAbsolute(data))) throw Object.assign(new Error('The shared folder must not contain Gather configuration or authentication files.'), { status: 400 });
  return candidate;
}

export function validateSettings(input: Record<string, unknown>): Settings {
  const previous = readSettings();
  const string = (key: keyof Settings, max = 4096) => {
    const value = input[key];
    if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw Object.assign(new Error(`Invalid value for ${key}.`), { status: 400 });
    return value.trim();
  };
  const collectionName = string('collectionName', 120);
  if (!collectionName) throw Object.assign(new Error('Enter a collection name.'), { status: 400 });
  const photoRoot = validatePhotoRoot(string('photoRoot'));
  const immichUrl = string('immichUrl');
  if (immichUrl) {
    const url = new URL(immichUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Object.assign(new Error('Use an HTTP or HTTPS Immich address without credentials or query parameters.'), { status: 400 });
  }
  const immichLibraryId = string('immichLibraryId', 64);
  if (immichLibraryId && !/^[0-9a-f-]{36}$/i.test(immichLibraryId)) throw Object.assign(new Error('Enter a valid Immich library UUID.'), { status: 400 });
  const immichPhotoRoot = process.env.IMMICH_ALLOWED_ROOT
    ? path.posix.join(process.env.IMMICH_ALLOWED_ROOT, path.relative(allowedPhotoRoot(), photoRoot).split(path.sep).join('/'))
    : string('immichPhotoRoot');
  if (immichPhotoRoot && (!path.posix.isAbsolute(immichPhotoRoot) || immichPhotoRoot.includes('\\') || path.posix.normalize(immichPhotoRoot) !== immichPhotoRoot)) throw Object.assign(new Error('Enter the absolute collection path visible inside Immich.'), { status: 400 });
  if (input.readOnly !== undefined && typeof input.readOnly !== 'boolean') throw Object.assign(new Error('Invalid read-only setting.'), { status: 400 });
  return { readOnly: input.readOnly === true, collectionName, photoRoot, immichUrl, immichLibraryId, immichPhotoRoot,
    immichApiKey: string('immichApiKey', 1024) || previous.immichApiKey,
    immichScanApiKey: string('immichScanApiKey', 1024) || previous.immichScanApiKey };
}
