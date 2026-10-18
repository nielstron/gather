import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { createLimiter, mapConcurrent } from '../async';
import type { ImportStatus, ImportSummary } from '../imports';
import type { Member } from '../types';
import { config } from './config';
import { readSettings, collectionDataRoot, currentCollectionId, withSettings } from './settings';
import { listMembers, readFileChecksum } from './auth';
import { decodeId, duplicatePhoto, MediaError, saveUpload } from './media';
import { requestLibraryScan } from './immich';
import { discoverGoogleAlbum, fetchGooglePhoto, googleFilename, type GooglePhoto } from './google-photos';

type Job = { id: string; memberId: string; root: string; source: string; title: string; total: number; unsupported: number; status: ImportStatus; created: number; updated: number; error?: string };
type Item = GooglePhoto & { index: number; status: 'pending' | 'running' | 'imported' | 'duplicate' | 'failed'; name?: string; error?: string };
const connections = new Map<string, Database.Database>();
const slots = createLimiter(2);

function db() {
  const filename = path.join(collectionDataRoot(), 'imports.sqlite');
  let connection = connections.get(filename);
  if (connection) return connection;
  mkdirSync(collectionDataRoot(), { recursive: true, mode: 0o700 });
  connection = new Database(filename); chmodSync(filename, 0o600);
  connection.pragma('journal_mode = WAL'); connection.pragma('foreign_keys = ON');
  connection.exec(`
    CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, member_id TEXT NOT NULL, root TEXT NOT NULL, status TEXT NOT NULL, updated INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS jobs_owner ON jobs(member_id, root, updated);
    CREATE TABLE IF NOT EXISTS items (job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, ordinal INTEGER NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(job_id, ordinal));
    CREATE INDEX IF NOT EXISTS items_status ON items(job_id, status);
    CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, size INTEGER NOT NULL, updated INTEGER NOT NULL);
  `);
  connections.set(filename, connection); return connection;
}
function writeJob(job: Job) {
  job.updated = Date.now();
  db().prepare('INSERT INTO jobs VALUES (?,?,?,?,?,?)').run(job.id, job.memberId, job.root, job.status, job.updated, JSON.stringify(job));
}
function updateJob(job: Job) {
  job.updated = Date.now();
  db().prepare('UPDATE jobs SET status=?, updated=?, data=? WHERE id=?').run(job.status, job.updated, JSON.stringify(job), job.id);
}
function writeItem(job: Job, item: Item) {
  db().prepare('INSERT OR REPLACE INTO items VALUES (?,?,?,?)').run(job.id, item.index, item.status, JSON.stringify(item));
  job.updated = Date.now();
  db().prepare('UPDATE jobs SET updated=?,data=? WHERE id=?').run(job.updated, JSON.stringify(job), job.id);
}
function readJob(member: Member, id: string): Job {
  const row = db().prepare('SELECT data FROM jobs WHERE id=? AND member_id=? AND root=?').get(id, member.id, config.photoRoot) as { data: string } | undefined;
  if (!row) throw new MediaError(404, 'Import not found.');
  return JSON.parse(row.data);
}
function summary(job: Job): ImportSummary {
  const counts = Object.fromEntries((db().prepare('SELECT status, count(*) AS count FROM items WHERE job_id=? GROUP BY status').all(job.id) as { status: string; count: number }[]).map(row => [row.status, row.count]));
  const files = (db().prepare("SELECT data FROM items WHERE job_id=? AND status IN ('running','failed') ORDER BY ordinal LIMIT 10").all(job.id) as { data: string }[]).map(row => {
    const item: Item = JSON.parse(row.data); return { name: item.name || `Photo ${item.index + 1}`, ...(item.error ? { error: item.error } : {}) };
  });
  const imported = counts.imported || 0, duplicates = counts.duplicate || 0, failed = counts.failed || 0;
  return { id: job.id, title: job.title, status: job.status, total: job.total, unsupported: job.unsupported, imported, duplicates, failed, processed: imported + duplicates + failed, created: job.created, updated: job.updated, ...(job.error ? { error: job.error } : {}), files };
}
const sourceKey = (item: GooglePhoto) => createHash('sha256').update(JSON.stringify([item.id, item.url, item.modified])).digest('hex');
const transient = (error: unknown) => !((error as { status?: number })?.status) || [408, 429, 502, 503, 504].includes((error as { status: number }).status);

/** Background imports are isolated by collection/member and survive closing the browser. */
export function createImporter(dependencies: {
  discover?: typeof discoverGoogleAlbum; download?: typeof fetchGooglePhoto; scan?: () => Promise<unknown>;
} = {}) {
  const discover = dependencies.discover || discoverGoogleAlbum;
  const download = dependencies.download || fetchGooglePhoto;
  const scan = dependencies.scan || requestLibraryScan;
  const running = new Map<string, { controller: AbortController; promise: Promise<void>; job: Job }>();
  const jobKey = (id: string) => `${collectionDataRoot()}:${id}`;

  function schedule(job: Job, member: Member) {
    const key = jobKey(job.id);
    if (running.has(key)) return;
    const controller = new AbortController();
    const collection = currentCollectionId();
    const entry = { controller, job, promise: Promise.resolve() };
    running.set(key, entry);
    entry.promise = slots(async () => {
      if (controller.signal.aborted) return;
      job.status = 'running'; delete job.error; updateJob(job);
      const items = (db().prepare('SELECT data FROM items WHERE job_id=? ORDER BY ordinal').all(job.id) as { data: string }[]).map(row => JSON.parse(row.data) as Item);
      // Interrupted downloads resume; completed photos are never fetched again.
      const pending = items.filter(item => ['pending', 'running'].includes(item.status));
      await mapConcurrent(pending, 2, async item => {
        if (controller.signal.aborted) return;
        const authorized = withSettings(() => !readSettings().readOnly && config.photoRoot === job.root && listMembers().some(user => user.id === member.id), collection);
        if (!authorized) { job.error = 'Import stopped because collection access or its shared folder changed.'; controller.abort(); return; }
        item.status = 'running'; delete item.error; writeItem(job, item);
        for (let attempt = 0; attempt < 4; attempt++) {
          let response: Response | undefined;
          try {
            const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]);
            const known = db().prepare('SELECT checksum,size FROM sources WHERE id=?').get(sourceKey(item)) as { checksum: string; size: number } | undefined;
            if (known) {
              const existing = await duplicatePhoto(known.checksum, known.size, signal);
              if (existing) { item.name = existing.name; item.status = 'duplicate'; break; }
            }
            response = await download(item, signal);
            const size = Number(response.headers.get('content-length'));
            if (size > config.maxUploadBytes) throw new MediaError(413, `This photo exceeds the ${config.maxUploadBytes / 1024 / 1024} MB upload limit.`);
            item.name = googleFilename(item, response); writeItem(job, item);
            const photo = await saveUpload(member, item.name, response.body, signal);
            item.status = photo.duplicate ? 'duplicate' : 'imported'; item.name = photo.name;
            const checksum = readFileChecksum(decodeId(photo.id), photo.revision!);
            if (checksum) db().prepare('INSERT OR REPLACE INTO sources VALUES (?,?,?,?)').run(sourceKey(item), checksum, photo.bytes, Date.now());
            if (!photo.duplicate) void scan().catch(() => {});
            break;
          } catch (error) {
            if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
            if (controller.signal.aborted) { item.status = 'pending'; break; }
            if (attempt < 3 && transient(error)) {
              try { await delay(500 * 2 ** attempt, undefined, { signal: controller.signal }); } catch { item.status = 'pending'; break; }
              continue;
            }
            item.status = 'failed';
            item.error = error instanceof MediaError ? error.message : 'The connection was interrupted. Retry this import to continue.';
            break;
          }
        }
        writeItem(job, item);
      });
      job.status = controller.signal.aborted ? 'cancelled' : items.some(item => item.status === 'failed') ? 'partial' : 'done';
      updateJob(job);
      db().prepare('DELETE FROM sources WHERE id IN (SELECT id FROM sources ORDER BY updated DESC LIMIT -1 OFFSET 20000)').run();
    }).catch(() => {
      job.status = 'error'; job.error = 'The import stopped unexpectedly. Retry to continue with the remaining photos.';
      try { updateJob(job); } catch { console.error('Gather: import progress could not be saved.'); }
    }).finally(() => { running.delete(key); });
  }

  function start(member: Member, id: string) {
    const job = readJob(member, id);
    const existing = running.get(jobKey(id));
    if (existing?.controller.signal.aborted) throw new MediaError(409, 'Cancellation is finishing. Retry in a moment.');
    if (existing || job.status === 'done') return summary(job);
    const busy = db().prepare("SELECT id FROM jobs WHERE member_id=? AND root=? AND status IN ('queued','running') AND id<>?").get(member.id, config.photoRoot, id);
    if (busy) throw new MediaError(409, 'Finish or cancel your current import before starting another.');
    if (Date.now() - job.created > 7 * 86400_000) throw new MediaError(410, 'Preview this album again to refresh its download links.');
    const items = db().prepare("SELECT data FROM items WHERE job_id=? AND status IN ('failed','running')").all(id) as { data: string }[];
    for (const row of items) { const item: Item = JSON.parse(row.data); item.status = 'pending'; delete item.error; writeItem(job, item); }
    job.status = 'queued'; delete job.error; updateJob(job); schedule(job, member);
    return summary(job);
  }

  return {
    async preview(member: Member, url: string, signal?: AbortSignal) {
      // Bound preview history and capability URLs kept on disk.
      db().prepare("DELETE FROM jobs WHERE updated<? AND status NOT IN ('queued','running')").run(Date.now() - 30 * 86400_000);
      if ((db().prepare('SELECT count(*) AS count FROM jobs').get() as { count: number }).count >= 500) throw new MediaError(429, 'Too many recent imports. Try again later.');
      const album = await discover(url, signal);
      if (!album.photos.length) throw new MediaError(400, album.unsupported ? 'This album contains only videos. Gather currently imports photos.' : 'This album has no downloadable photos.');
      const job: Job = { id: randomUUID(), memberId: member.id, root: config.photoRoot, source: album.url, title: album.title, total: album.photos.length, unsupported: album.unsupported, status: 'ready', created: Date.now(), updated: Date.now() };
      db().transaction(() => {
        db().prepare("DELETE FROM jobs WHERE member_id=? AND root=? AND status='ready'").run(member.id, config.photoRoot);
        writeJob(job);
        album.photos.forEach((photo, index) => writeItem(job, { ...photo, index, status: 'pending' }));
      })();
      return summary(job);
    },
    start,
    cancel(member: Member, id: string) {
      const job = readJob(member, id), entry = running.get(jobKey(id));
      if (entry) { entry.job.status = 'cancelled'; entry.controller.abort(); updateJob(entry.job); return summary(entry.job); }
      if (['queued', 'running', 'ready', 'partial', 'error'].includes(job.status)) { job.status = 'cancelled'; updateJob(job); }
      return summary(job);
    },
    list(member: Member) {
      const rows = db().prepare('SELECT data FROM jobs WHERE member_id=? AND root=? ORDER BY updated DESC LIMIT 20').all(member.id, config.photoRoot) as { data: string }[];
      return rows.map(row => {
        const job: Job = JSON.parse(row.data);
        if (['queued', 'running'].includes(job.status) && !running.has(jobKey(job.id))) schedule(job, member);
        return summary(job);
      });
    },
    async settled(id: string) { await running.get(jobKey(id))?.promise; }
  };
}

export const importer = createImporter();
