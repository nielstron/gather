import { MediaError } from './media';

export type GooglePhoto = { id: string; url: string; modified: number };
export type GoogleAlbum = { url: string; title: string; photos: GooglePhoto[]; unsupported: number };
const maxPhotos = 1000;
const metadataLimit = 8 * 1024 * 1024;
type Fetcher = typeof fetch;

/** Accept shared albums, never arbitrary URLs, credentials, or user-selected ports. */
export function googleAlbumUrl(input: string): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new MediaError(400, 'Paste a shared Google Photos album link.'); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password) throw new MediaError(400, 'Use an HTTPS Google Photos sharing link.');
  if (url.hostname === 'photos.app.goo.gl' && /^\/[A-Za-z0-9_-]{5,100}\/?$/.test(url.pathname)) {
    url.search = ''; url.hash = ''; return url;
  }
  if (url.hostname === 'photos.google.com' && /^\/share\/AF1Q[A-Za-z0-9_-]{15,200}\/?$/.test(url.pathname)) {
    const key = url.searchParams.get('key');
    if (key && !/^[A-Za-z0-9_-]{10,200}$/.test(key)) throw new MediaError(400, 'This album link has an invalid sharing key.');
    url.search = ''; if (key) url.searchParams.set('key', key);
    url.hash = ''; return url;
  }
  throw new MediaError(400, 'Currently, import supports shared Google Photos album links.');
}

export function googleMediaUrl(input: string): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new MediaError(502, 'Google returned an invalid photo address.'); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !/^lh\d{1,2}\.googleusercontent\.com$/.test(url.hostname)) {
    throw new MediaError(502, 'Google returned an unsupported photo address.');
  }
  url.hash = ''; return url;
}

async function checkedFetch(input: URL, kind: 'album' | 'media' | 'rpc', signal: AbortSignal, fetcher: Fetcher, init?: RequestInit) {
  let url = input;
  for (let redirect = 0; redirect < 5; redirect++) {
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await fetcher(url, { ...init, redirect: 'manual', signal, headers: { 'Accept-Language': 'en', ...init?.headers } });
    } catch {
      signal.throwIfAborted();
      throw new MediaError(502, 'Google could not be reached. Please try again.');
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location'); await response.body?.cancel();
      if (!location || kind === 'rpc') throw new MediaError(502, 'Google redirected this request unexpectedly.');
      const target = new URL(location, url);
      try { url = kind === 'album' ? googleAlbumUrl(target.href) : googleMediaUrl(target.href); }
      catch { throw new MediaError(400, 'This album needs a Google login or is no longer publicly shared.'); }
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 429 || response.status >= 500) throw new MediaError(503, 'Google is temporarily unavailable or is limiting downloads. Try again shortly.');
      throw new MediaError(400, 'This album or photo is unavailable. Check that link sharing and downloads are enabled.');
    }
    return { response, url };
  }
  throw new MediaError(400, 'This sharing link redirects too many times.');
}

async function limitedText(response: Response) {
  if (!response.body) throw new MediaError(502, 'Google returned an empty album response.');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > metadataLimit) { await reader.cancel(); throw new MediaError(413, 'This album response is too large to import.'); }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof MediaError) throw error;
    throw new MediaError(502, 'Google interrupted the album response. Please try previewing the link again.');
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

/** Google embeds JSON in callbacks. Parse data only; never evaluate page scripts. */
export function albumData(html: string): unknown[] {
  for (const match of html.matchAll(/AF_initDataCallback\(\{key:\s*['"]ds:1['"][\s\S]*?data:([\s\S]*?),\s*sideChannel:[\s\S]*?\}\);/g)) {
    try {
      const data = JSON.parse(match[1]);
      if (Array.isArray(data) && Array.isArray(data[1]) && Array.isArray(data[3])) return data;
    } catch { /* A different callback is not an album. */ }
  }
  throw new MediaError(502, 'Google did not return a readable shared album. Check the link and try again; Google may have changed its sharing page.');
}

function pageData(text: string): unknown[] {
  for (const line of text.split('\n')) {
    if (!line.startsWith('[')) continue;
    try {
      const frames = JSON.parse(line);
      for (const frame of frames) {
        if (frame?.[0] === 'wrb.fr' && frame[1] === 'snAcKc' && typeof frame[2] === 'string') {
          const payload = JSON.parse(frame[2]); if (Array.isArray(payload)) return payload;
        }
      }
    } catch { /* Other batched response frames are not album data. */ }
  }
  throw new MediaError(502, 'The rest of this Google album could not be read. Nothing has been imported; try previewing the link again.');
}

export async function discoverGoogleAlbum(input: string, signal = AbortSignal.timeout(60_000), fetcher: Fetcher = fetch): Promise<GoogleAlbum> {
  const checked = await checkedFetch(googleAlbumUrl(input), 'album', signal, fetcher);
  if (checked.url.hostname !== 'photos.google.com') { await checked.response.body?.cancel(); throw new MediaError(400, 'This link did not open a shared Google Photos album.'); }
  const html = await limitedText(checked.response);
  let data = albumData(html);
  const meta = data[3] as unknown[];
  const expected = meta[21];
  if (typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected < 0) throw new MediaError(502, 'Google did not provide a complete album count. Nothing has been imported; try previewing the link again.');
  if (expected > maxPhotos) throw new MediaError(413, `Import up to ${maxPhotos.toLocaleString()} photos at a time. Split this album into smaller shared albums.`);
  const title = typeof meta[1] === 'string' && meta[1].trim() ? meta[1].trim().slice(0, 200) : 'Shared Google Photos album';
  const photos = new Map<string, GooglePhoto>(); const videos = new Set<string>(); const cursors = new Set<string>();
  for (let page = 0; page < 20; page++) {
    if (!Array.isArray(data[1])) throw new MediaError(502, 'Google returned an unreadable album page.');
    for (const row of data[1]) {
      if (!Array.isArray(row) || typeof row[0] !== 'string' || !Array.isArray(row[1]) || typeof row[1][0] !== 'string') throw new MediaError(502, 'Google returned an unreadable photo record.');
      const properties = row.at(-1);
      if (properties && !Array.isArray(properties) && typeof properties === 'object' && properties['76647426'] != null) { videos.add(row[0]); continue; }
      photos.set(row[0], { id: row[0], url: googleMediaUrl(row[1][0]).href, modified: typeof row[5] === 'number' ? row[5] : 0 });
    }
    if (photos.size + videos.size > maxPhotos) throw new MediaError(413, 'This album exceeds the 1,000-photo import limit.');
    const cursor = data[2];
    if (!cursor) {
      if (photos.size + videos.size !== expected) throw new MediaError(502, 'Google returned an incomplete album. Nothing has been imported; try previewing the link again.');
      return { url: checked.url.href, title, photos: [...photos.values()], unsupported: videos.size };
    }
    if (typeof cursor !== 'string' || cursors.has(cursor)) break;
    cursors.add(cursor);
    const endpoint = new URL('https://photos.google.com/_/PhotosUi/data/batchexecute');
    endpoint.searchParams.set('rpcids', 'snAcKc'); endpoint.searchParams.set('source-path', checked.url.pathname); endpoint.searchParams.set('rt', 'c');
    // These public page identifiers keep pagination on the same Google web version.
    for (const [field, parameter] of [['FdrFJe', 'f.sid'], ['cfb2h', 'bl']]) {
      const match = new RegExp('"' + field + '":("(?:[^"\\\\]|\\\\.)*")').exec(html);
      if (match) { try { endpoint.searchParams.set(parameter, JSON.parse(match[1])); } catch { /* Optional public identifier. */ } }
    }
    const body = new URLSearchParams({ 'f.req': JSON.stringify([[['snAcKc', JSON.stringify([meta[0], cursor, null, checked.url.searchParams.get('key') || meta[19] || null]), null, 'generic']]]) });
    const next = await checkedFetch(endpoint, 'rpc', signal, fetcher, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    data = pageData(await limitedText(next.response));
  }
  throw new MediaError(502, 'Google album pagination stopped unexpectedly. Nothing has been imported; try a smaller shared album.');
}

export async function fetchGooglePhoto(photo: GooglePhoto, signal: AbortSignal, fetcher: Fetcher = fetch): Promise<Response> {
  const url = googleMediaUrl(photo.url);
  url.pathname = url.pathname.replace(/=[^/]*$/, '') + '=d';
  return (await checkedFetch(url, 'media', signal, fetcher)).response;
}

/** Keep Google's supplied filename when it is safe and supported by Gather. */
export function googleFilename(photo: GooglePhoto, response: Response) {
  const disposition = response.headers.get('content-disposition') || '';
  let name = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  try { if (name) name = decodeURIComponent(name); } catch { name = undefined; }
  name ||= /filename="([^"]+)"/i.exec(disposition)?.[1] || /filename=([^;]+)/i.exec(disposition)?.[1]?.trim();
  name = name?.split(/[\\/]/).at(-1)?.replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (name && name.length <= 180 && !name.startsWith('.') && /\.(?:jpe?g|png|webp|avif|gif|tiff?|heic|heif)$/i.test(name)) return name;
  const extension = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/avif': 'avif', 'image/gif': 'gif', 'image/tiff': 'tiff', 'image/heic': 'heic', 'image/heif': 'heif' } as Record<string, string>)[response.headers.get('content-type')?.split(';')[0] || ''];
  if (!extension) throw new MediaError(415, 'Google returned an unsupported file instead of a photo.');
  return `google-${photo.id.replace(/[^A-Za-z0-9_-]/g, '').slice(-32)}.${extension}`;
}
