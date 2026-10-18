/** Shared decoded-image URLs stay alive while either gallery or viewer uses them. */
export type ThumbnailLease = { url: string; release: () => void };
type Entry = { url: string; users: number };
const thumbnails = new Map<string, Entry>();

function lease(key: string, entry: Entry): ThumbnailLease {
  entry.users++;
  let released = false;
  return { url: entry.url, release() {
    if (released) return;
    released = true;
    if (--entry.users === 0) { thumbnails.delete(key); URL.revokeObjectURL(entry.url); }
  } };
}

export function retainThumbnail(key: string): ThumbnailLease | undefined {
  const entry = thumbnails.get(key);
  return entry ? lease(key, entry) : undefined;
}

export function cacheThumbnail(key: string, blob: Blob): ThumbnailLease {
  let entry = thumbnails.get(key);
  if (!entry) { entry = { url: URL.createObjectURL(blob), users: 0 }; thumbnails.set(key, entry); }
  return lease(key, entry);
}
