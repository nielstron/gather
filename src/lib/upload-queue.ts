/** Private, per-member recovery queue. File bytes stay on this device until sent. */
export type SavedUpload = { key: string; scope: string; id: string; file: File; created: number; checksum?: string; error?: string };
let database: Promise<IDBDatabase> | undefined;
const writes = new Map<string, Promise<void>>();
function db() {
  return database ||= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('gather-upload-queue', 1);
    request.onupgradeneeded = () => { const store = request.result.createObjectStore('files', { keyPath: 'key' }); store.createIndex('scope', 'scope'); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { database = undefined; reject(request.error); };
    request.onblocked = () => { database = undefined; reject(new Error('Browser upload storage is busy.')); };
  });
}
async function write(scope: string, id: string, action: (store: IDBObjectStore, key: string) => void) {
  const key = `${scope}:${id}`;
  const previous = writes.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const connection = await db();
    await new Promise<void>((resolve, reject) => {
      const transaction = connection.transaction('files', 'readwrite');
      transaction.oncomplete = () => resolve();
      transaction.onabort = transaction.onerror = () => reject(transaction.error || new Error('Browser upload storage is unavailable.'));
      action(transaction.objectStore('files'), key);
    });
  });
  writes.set(key, next);
  try { await next; } finally { if (writes.get(key) === next) writes.delete(key); }
}
export function saveQueuedUpload(scope: string, id: string, file: File) {
  return write(scope, id, (store, key) => { store.put({ key, scope, id, file, created: Date.now() } satisfies SavedUpload); });
}
export function updateQueuedUpload(scope: string, id: string, patch: Pick<SavedUpload, 'checksum' | 'error'>) {
  return write(scope, id, (store, key) => {
    const request = store.get(key);
    request.onsuccess = () => { if (request.result) store.put({ ...request.result, ...patch }); };
  });
}
export function removeQueuedUpload(scope: string, id: string) { return write(scope, id, (store, key) => { store.delete(key); }); }
export async function restoreQueuedUploads(scope: string): Promise<SavedUpload[]> {
  const connection = await db();
  return new Promise((resolve, reject) => {
    const request = connection.transaction('files').objectStore('files').index('scope').getAll(scope);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const records = request.result as SavedUpload[];
      const oldest = Date.now() - 7 * 86400_000;
      for (const record of records) if (record.created < oldest) void removeQueuedUpload(scope, record.id).catch(() => {});
      resolve(records.filter(record => record.created >= oldest).sort((a, b) => a.created - b.created));
    };
  });
}
