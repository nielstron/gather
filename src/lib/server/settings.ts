import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type Settings = {
  collectionName: string;
  photoRoot: string;
  immichUrl: string;
  immichLibraryId: string;
  immichPhotoRoot: string;
  immichApiKey: string;
  immichScanApiKey: string;
};

export function dataRoot() { return path.resolve(process.env.DATA_ROOT || './var/data'); }

const requestSettings = new AsyncLocalStorage<Settings>();

export function withSettings<T>(callback: () => T): T {
  return requestSettings.run(readSettings(), callback);
}

export function readSettings(): Settings {
  const snapshot = requestSettings.getStore();
  if (snapshot) return snapshot;
  const filename = path.join(dataRoot(), 'settings.json');
  const saved: Partial<Settings> = existsSync(filename) ? JSON.parse(readFileSync(filename, 'utf8')) : {};
  return {
    collectionName: saved.collectionName ?? process.env.COLLECTION_NAME ?? 'Our shared moments',
    photoRoot: saved.photoRoot ?? path.resolve(process.env.PHOTO_ROOT || './var/photos'),
    immichUrl: saved.immichUrl ?? process.env.IMMICH_URL ?? '',
    immichLibraryId: saved.immichLibraryId ?? process.env.IMMICH_LIBRARY_ID ?? '',
    immichPhotoRoot: saved.immichPhotoRoot ?? process.env.IMMICH_PHOTO_ROOT ?? '',
    immichApiKey: saved.immichApiKey ?? process.env.IMMICH_API_KEY ?? '',
    immichScanApiKey: saved.immichScanApiKey ?? process.env.IMMICH_SCAN_API_KEY ?? '',
  };
}

export function writeSettings(settings: Settings) {
  mkdirSync(dataRoot(), { recursive: true, mode: 0o700 });
  const filename = path.join(dataRoot(), 'settings.json');
  const temporary = filename + '.tmp';
  writeFileSync(temporary, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, filename);
  const snapshot = requestSettings.getStore();
  if (snapshot) Object.assign(snapshot, settings);
}
