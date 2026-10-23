import { readSettings } from './settings';
import { normalizeBasePath } from '../base-path';
import path from 'node:path';

function positiveInteger(value: string | undefined, fallback: number) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error('Invalid positive integer in configuration');
  return number;
}

export const config = {
  basePath: normalizeBasePath(process.env.GATHER_BASE_PATH),
  get photoRoot() { return readSettings().photoRoot; },
  dataRoot: path.resolve(process.env.DATA_ROOT || './var/data'),
  get collectionName() { return readSettings().collectionName; },
  maxUploadBytes: positiveInteger(process.env.MAX_UPLOAD_MB, 1024) * 1024 * 1024,
  sessionDays: positiveInteger(process.env.SESSION_DAYS, 30),
  secureCookies: process.env.COOKIE_SECURE !== 'false',
  origin: process.env.ORIGIN || 'http://localhost:5173'
};

const relative = path.relative(config.photoRoot, config.dataRoot);
if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
  throw new Error('DATA_ROOT must be outside PHOTO_ROOT');
}
