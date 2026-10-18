import { error } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type Settings = {
  readOnly?: boolean;
  collectionName: string;
  photoRoot: string;
  immichUrl: string;
  immichLibraryId: string;
  immichPhotoRoot: string;
  immichApiKey: string;
  immichScanApiKey: string;
};

export function dataRoot() { return path.resolve(process.env.DATA_ROOT || './var/data'); }

type Snapshot = { id: string; settings: Settings };
const requestSettings = new AsyncLocalStorage<Snapshot>();
const validId = /^[a-z0-9-]{1,64}$/;
function settingsFile(id: string) { return id === 'default' ? path.join(dataRoot(), 'settings.json') : path.join(dataRoot(), 'collections', id, 'settings.json'); }
function collectionIds(): string[] {
  const filename = path.join(dataRoot(), 'collections.json');
  return existsSync(filename) ? JSON.parse(readFileSync(filename, 'utf8')) : [];
}
function atomicJson(filename: string, value: unknown) {
  mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = filename + '.tmp';
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, filename);
}
export function currentCollectionId() { return requestSettings.getStore()?.id || 'default'; }
export function collectionDataRoot() {
  const id = currentCollectionId();
  return id === 'default' ? dataRoot() : path.join(dataRoot(), 'collections', id);
}
export function sessionCookieName() {
  const id = currentCollectionId();
  return id === 'default' ? 'gather_session' : `gather_session_${id}`;
}
export function withSettings<T>(callback: () => T, id = 'default'): T {
  return requestSettings.run({ id, settings: settingsFor(id) }, callback);
}
function settingsFor(id: string): Settings {
  if (!validId.test(id) || (id !== 'default' && !collectionIds().includes(id))) error(404, 'Collection not found');
  const filename = settingsFile(id);
  const saved: Partial<Settings> = existsSync(filename) ? JSON.parse(readFileSync(filename, 'utf8')) : {};
  return {
    readOnly: saved.readOnly === true,
    collectionName: saved.collectionName ?? process.env.COLLECTION_NAME ?? 'Our shared moments',
    photoRoot: saved.photoRoot ?? path.resolve(process.env.PHOTO_ROOT || './var/photos'),
    immichUrl: saved.immichUrl ?? process.env.IMMICH_URL ?? '',
    immichLibraryId: saved.immichLibraryId ?? process.env.IMMICH_LIBRARY_ID ?? '',
    immichPhotoRoot: saved.immichPhotoRoot ?? process.env.IMMICH_PHOTO_ROOT ?? '',
    immichApiKey: saved.immichApiKey ?? process.env.IMMICH_API_KEY ?? '',
    immichScanApiKey: saved.immichScanApiKey ?? process.env.IMMICH_SCAN_API_KEY ?? '',
  };
}
export function readSettings(): Settings { return requestSettings.getStore()?.settings || settingsFor('default'); }
export function writeSettings(settings: Settings) {
  atomicJson(settingsFile(currentCollectionId()), settings);
  const snapshot = requestSettings.getStore();
  if (snapshot) Object.assign(snapshot.settings, settings);
}
export function listCollections() {
  return ['default', ...collectionIds()].map(id => {
    const settings = settingsFor(id);
    return { id, name: settings.collectionName, photoRoot: settings.photoRoot };
  });
}
export function createCollection(settings: Settings) {
  const ids = collectionIds();
  if (ids.length >= 99) throw Object.assign(new Error('Up to 100 collections are supported.'), { status: 400 });
  const id = randomUUID();
  atomicJson(settingsFile(id), settings);
  atomicJson(path.join(dataRoot(), 'collections.json'), [...ids, id]);
  return id;
}
