import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { after, before, test } from 'node:test';
import { enrichPhotos, fetchImmichImage, ImmichError, requestLibraryScan, searchCollection, collectionPeople } from '../src/lib/server/immich.js';
import type { Photo } from '../src/lib/types.js';

const LIBRARY = '11111111-1111-4111-8111-111111111111';
const ASSET = '22222222-2222-4222-8222-222222222222';
let handler: (req: IncomingMessage, res: ServerResponse, body: Record<string, any>) => void = (_req, res) => { res.writeHead(500).end(); };
let base = '';
let sequence = 0;
const requests: { url: string; key: string | string[] | undefined; body: Record<string, any> }[] = [];
const server = createServer(async (req, res) => {
  const parts: Buffer[] = [];
  for await (const part of req) parts.push(Buffer.from(part));
  const text = Buffer.concat(parts).toString();
  const body = text ? JSON.parse(text) : {};
  requests.push({ url: req.url!, key: req.headers['x-api-key'], body });
  handler(req, res, body);
});
const saved = { ...process.env };
const dataRoot = mkdtempSync(path.join(os.tmpdir(), 'gather-immich-'));
process.env.DATA_ROOT = dataRoot;
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  base = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  for (const key of ['IMMICH_URL', 'IMMICH_API_KEY', 'IMMICH_SCAN_API_KEY', 'IMMICH_LIBRARY_ID', 'IMMICH_PHOTO_ROOT', 'IMMICH_SCAN_MODE', 'DATA_ROOT']) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
  rmSync(dataRoot, { recursive: true, force: true });
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
function configure() {
  requests.length = 0;
  process.env.IMMICH_URL = `${base}/api/`;
  process.env.IMMICH_API_KEY = `private-test-key-${++sequence}`;
  process.env.IMMICH_LIBRARY_ID = LIBRARY;
  process.env.IMMICH_PHOTO_ROOT = '/external/shared photos';
  delete process.env.IMMICH_SCAN_API_KEY;
  delete process.env.IMMICH_SCAN_MODE;
}
function photo(relative = 'alice/summer.jpg'): Photo {
  return { id: Buffer.from(relative).toString('base64url'), name: relative.split('/').at(-1)!, folder: 'alice', owner: 'Alice', width: 4, height: 3, bytes: 10, modifiedAt: new Date(0).toISOString(), previewStatus: 'pending' };
}
function asset(originalPath = '/external/shared photos/alice/summer.jpg', extra: Record<string, unknown> = {}) {
  return { id: ASSET, originalPath, libraryId: LIBRARY, width: 1600, height: 900, thumbhash: 'preview-hash', ...extra };
}
function json(res: ServerResponse, items: unknown[], extra = {}) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ assets: { items, nextCursor: null, nextPage: null, ...extra } })); }

test('batches exact paths across mount roots, rejecting wrong libraries and matching basenames', async () => {
  configure();
  handler = (_req, res, body) => {
    assert.deepEqual(body.filter.libraryId, { eq: LIBRARY });
    assert.deepEqual(body.filter.originalPath.in, ['/external/shared photos/alice/summer.jpg', '/external/shared photos/bob/summer.jpg']);
    json(res, [asset(), asset('/elsewhere/bob/summer.jpg'), asset('/external/shared photos/bob/summer.jpg', { libraryId: 'different-library' })]);
  };
  const result = await enrichPhotos([photo(), photo('bob/summer.jpg')]);
  assert.equal(result.previewService, 'ready');
  assert.equal(result.photos[0].previewStatus, 'ready');
  assert.equal(result.photos[0].width, 1600);
  assert.equal(result.photos[1].previewStatus, 'pending');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].key, process.env.IMMICH_API_KEY);
  assert(!JSON.stringify(result).includes(process.env.IMMICH_API_KEY!));
  await enrichPhotos([photo()]);
  assert.equal(requests.length, 1, 'short-lived lookup cache avoids repeated searches');
});

test('unconfigured and failed connections differ from images pending indexing', async () => {
  configure();
  delete process.env.IMMICH_API_KEY;
  assert.equal((await enrichPhotos([photo()])).previewService, 'unconfigured');
  assert.equal(requests.length, 0);
  configure();
  handler = (_req, res) => res.writeHead(403).end('private upstream error');
  const result = await enrichPhotos([photo()]);
  assert.equal(result.previewService, 'unavailable');
  assert.equal(requests.length, 1, 'authorization failure does not trigger legacy retries');
  assert(!JSON.stringify(result).includes('private upstream'));
});

test('legacy compatibility is restricted to schema rejection and still verifies exact paths', async () => {
  configure();
  handler = (_req, res, body) => {
    if (body.filter) { res.writeHead(400).end(); return; }
    assert.equal(body.libraryId, LIBRARY);
    assert.equal(body.originalPath, '/external/shared photos/alice/summer.jpg');
    if (body.page === 1) json(res, [asset('/external/shared photos/alice/summer.jpg.extra')], { nextPage: '2' });
    else json(res, [asset()]);
  };
  const result = await enrichPhotos([photo()]);
  assert.equal(result.photos[0].previewStatus, 'ready');
  assert.equal(requests.length, 3);
});

test('new uploads stay pending and never fall back to another image or a generated thumbnail', async () => {
  configure();
  handler = (_req, res) => json(res, []);
  const result = await enrichPhotos([photo()]);
  assert.equal(result.photos[0].previewStatus, 'pending');
  await assert.rejects(fetchImmichImage('alice/summer.jpg', 'thumbnail'), (error: unknown) => error instanceof ImmichError && error.status === 404 && error.message.includes('index'));
  assert.equal(requests.length, 1);
});

test('proxies images privately with server credentials and only safe response headers', async () => {
  configure();
  handler = (req, res) => {
    if (req.url === '/api/search/metadata') return json(res, [asset()]);
    assert.equal(req.url, `/api/assets/${ASSET}/thumbnail?size=preview`);
    res.writeHead(200, { 'content-type': 'image/webp', 'set-cookie': 'private=secret', 'cache-control': 'public, max-age=99999', 'x-internal-path': '/private/storage' });
    res.end('webp-image-bytes');
  };
  const response = await fetchImmichImage('alice/summer.jpg', 'preview');
  assert.equal(await response.text(), 'webp-image-bytes');
  assert.equal(response.headers.get('content-type'), 'image/webp');
  assert.equal(response.headers.get('cache-control'), 'private, max-age=60');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('x-internal-path'), null);
  assert.equal(requests[1].key, process.env.IMMICH_API_KEY);
});

test('rejects redirects, non-images, and traversal before exposing upstream content', async () => {
  for (const mode of ['redirect', 'html']) {
    configure();
    handler = (req, res) => {
      if (req.url === '/api/search/metadata') return json(res, [asset()]);
      if (mode === 'redirect') res.writeHead(302, { location: `${base}/credential-sink` }).end();
      else res.writeHead(200, { 'content-type': 'text/html' }).end('<script>bad</script>');
    };
    await assert.rejects(fetchImmichImage('alice/summer.jpg', 'thumbnail'), (error: unknown) => error instanceof ImmichError && error.status === 503);
    assert.equal(requests.length, 2, 'redirect is never followed with credentials');
  }
  configure();
  for (const invalid of ['../private.jpg', '/absolute.jpg', 'alice/../../private.jpg', 'alice\\private.jpg']) {
    await assert.rejects(fetchImmichImage(invalid, 'thumbnail'), (error: unknown) => error instanceof ImmichError && error.status === 400);
  }
  assert.equal(requests.length, 0);
});

test('indexed photos with missing media remain pending until Immich finishes', async () => {
  configure();
  handler = (req, res) => req.url === '/api/search/metadata' ? json(res, [asset()]) : res.writeHead(404).end();
  await assert.rejects(fetchImmichImage('alice/summer.jpg', 'thumbnail'), (error: unknown) => error instanceof ImmichError && error.status === 404);
  assert.equal((await enrichPhotos([photo()])).photos[0].previewStatus, 'pending');
  configure();
  handler = (_req, res) => json(res, [asset(undefined, { thumbhash: null })]);
  assert.equal((await enrichPhotos([photo()])).photos[0].previewStatus, 'pending');
});

test('queues only the configured library using a separate admin key and throttles repeated scans', async () => {
  configure();
  process.env.IMMICH_SCAN_API_KEY = 'separate-admin-scan-key';
  handler = (req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, `/api/libraries/${LIBRARY}/scan/path`);
    assert.equal(req.headers['x-api-key'], 'separate-admin-scan-key');
    assert.deepEqual(requests.at(-1)?.body, { path: '/external/shared photos' });
    res.writeHead(204).end();
  };
  assert.equal((await requestLibraryScan()).state, 'queued');
  assert.equal((await requestLibraryScan()).state, 'scheduled');
  assert.equal((await requestLibraryScan()).state, 'scheduled');
  assert.equal(requests.length, 1);
});

test('scan permission errors are actionable and do not claim indexing started', async () => {
  configure();
  handler = (_req, res) => res.writeHead(403).end('private upstream failure');
  const result = await requestLibraryScan();
  assert.equal(result.state, 'unavailable');
  assert.match(result.message!, /admin API key with library.update/);
  assert(!result.message?.includes('private upstream'));
  assert.equal((await requestLibraryScan()).state, 'unavailable');
  assert.equal(requests.length, 1);
});

test('a queued scan invalidates pending matches so newly indexed photos appear promptly', async () => {
  configure();
  let scanned = false;
  handler = (req, res) => {
    if (req.url?.endsWith('/scan/path')) { scanned = true; res.writeHead(204).end(); return; }
    json(res, scanned ? [asset()] : []);
  };
  assert.equal((await enrichPhotos([photo()])).photos[0].previewStatus, 'pending');
  assert.equal((await requestLibraryScan()).state, 'queued');
  assert.equal((await enrichPhotos([photo()])).photos[0].previewStatus, 'ready');
});

test('the trailing scan runs after the cooldown to catch files arriving during an earlier scan', async (t) => {
  configure();
  let scanCount = 0;
  let receivedSecond!: () => void;
  const secondScan = new Promise<void>((resolve) => { receivedSecond = resolve; });
  handler = (_req, res) => {
    scanCount++;
    res.writeHead(204).end();
    if (scanCount === 2) receivedSecond();
  };
  assert.equal((await requestLibraryScan()).state, 'queued');
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  assert.equal((await requestLibraryScan()).state, 'scheduled');
  assert.equal(scanCount, 1);
  t.mock.timers.tick(30_001);
  t.mock.timers.reset();
  await secondScan;
  assert.equal(scanCount, 2);
});


test('an unmodified Immich server falls back to scanning the configured library', async () => {
  configure();
  process.env.IMMICH_SCAN_API_KEY = 'fallback-admin-key';
  handler = (req, res, body) => {
    assert.equal(req.headers['x-api-key'], 'fallback-admin-key');
    if (req.url?.endsWith('/scan/path')) {
      assert.deepEqual(body, { path: '/external/shared photos' });
      res.writeHead(404).end();
    } else {
      assert.equal(req.url, `/api/libraries/${LIBRARY}/scan`);
      assert.deepEqual(body, {});
      res.writeHead(204).end();
    }
  };
  const result = await requestLibraryScan();
  assert.equal(result.state, 'queued');
  assert.match(result.message!, /configured library/);
  assert.deepEqual(requests.map(request => request.url), [
    `/api/libraries/${LIBRARY}/scan/path`, `/api/libraries/${LIBRARY}/scan`,
  ]);
  assert.equal((await requestLibraryScan()).state, 'scheduled');
  assert.equal(requests.length, 2, 'fallback shares the normal scan cooldown');
});

test('authorization, validation, and server errors do not trigger a broader scan', async () => {
  for (const status of [400, 401, 403, 500]) {
    configure();
    handler = (_req, res) => res.writeHead(status).end();
    assert.equal((await requestLibraryScan()).state, 'unavailable');
    assert.deepEqual(requests.map(request => request.url), [`/api/libraries/${LIBRARY}/scan/path`]);
  }
});

test('a failed full-library fallback never claims that a scan was queued', async () => {
  configure();
  handler = (req, res) => res.writeHead(req.url?.endsWith('/scan/path') ? 404 : 403).end();
  assert.equal((await requestLibraryScan()).state, 'unavailable');
  assert.equal(requests.length, 2);
});

test('explicit library mode skips the folder-scan request', async () => {
  configure();
  process.env.IMMICH_SCAN_MODE = 'library';
  handler = (req, res, body) => {
    assert.equal(req.url, `/api/libraries/${LIBRARY}/scan`);
    assert.deepEqual(body, {});
    res.writeHead(204).end();
  };
  try {
    assert.equal((await requestLibraryScan()).state, 'queued');
    assert.equal(requests.length, 1);
  } finally { delete process.env.IMMICH_SCAN_MODE; }
});


test('independent metadata batches overlap, share pending lookups, and respect the API concurrency limit', async () => {
  configure();
  let active = 0, peak = 0;
  handler = (_req, res, body) => {
    active++; peak = Math.max(peak, active);
    res.once('finish', () => { active--; });
    setTimeout(() => json(res, body.filter.originalPath.in.map((original: string) => asset(original))), 25);
  };
  const photos = Array.from({ length: 950 }, (_, index) => photo(`alice/batch-${index}.jpg`));
  const [first, second] = await Promise.all([enrichPhotos(photos), enrichPhotos(photos)]);
  assert.equal(first.photos.filter(photo => photo.previewStatus === 'ready').length, 950);
  assert.equal(second.photos.filter(photo => photo.previewStatus === 'ready').length, 950);
  assert.equal(requests.length, 10, 'one lookup per batch despite concurrent gallery requests');
  assert.ok(peak > 1, 'independent batches must overlap');
  assert.ok(peak <= 8, 'the shared API limit includes all batches and callers');
});

test('a slow Immich metadata response does not hold the gallery open', async () => {
  configure();
  let release!: () => void;
  handler = (_req, res) => { release = () => json(res, [asset()]); };
  const start = Date.now();
  const first = await enrichPhotos([photo()]);
  assert.ok(Date.now() - start < 3000, 'gallery has a short overall metadata deadline');
  assert.equal(first.photos[0].previewStatus, 'pending');
  release();
  const ready = await enrichPhotos([photo()]);
  assert.equal(ready.photos[0].previewStatus, 'ready');
  assert.equal(requests.length, 1, 'the background lookup is shared instead of restarted');
});

test('full-size images follow the same asset original redirect without exposing the API key', async () => {
  configure();
  handler = (req, res) => {
    if(req.url === '/api/search/metadata') json(res,[asset()]);
    else if(req.url?.endsWith('size=fullsize')) res.writeHead(302,{location:'original?'}).end();
    else { assert.equal(req.url,`/api/assets/${ASSET}/original`); res.writeHead(200,{'content-type':'image/jpeg'}).end('full-size image'); }
  };
  const response = await fetchImmichImage('alice/summer.jpg','fullsize');
  assert.equal(await response.text(),'full-size image');
  assert.equal(response.headers.get('cache-control'),'private, max-age=60');
  assert.equal(response.headers.get('x-api-key'),null);
  assert.equal(requests.length,3);
});

test('full-size conversion may fall back to the same asset preview', async () => {
  configure();
  handler = (req,res) => {
    if(req.url === '/api/search/metadata') json(res,[asset()]);
    else if(req.url?.endsWith('size=fullsize')) res.writeHead(302,{location:`/api/assets/${ASSET}/thumbnail?size=preview`}).end();
    else { assert.ok(req.url?.endsWith('size=preview')); res.writeHead(200,{'content-type':'image/webp'}).end('converted preview'); }
  };
  assert.equal(await (await fetchImmichImage('alice/summer.jpg','fullsize')).text(),'converted preview');
});

test('full-size redirects cannot send credentials to another origin or asset', async () => {
  for(const location of ['https://other.invalid/secret',`/api/assets/33333333-3333-4333-8333-333333333333/original`]){
    configure();
    handler=(req,res)=>{ if(req.url === '/api/search/metadata')json(res,[asset()]);else res.writeHead(302,{location}).end(); };
    await assert.rejects(fetchImmichImage('alice/summer.jpg','fullsize'),error=>error instanceof ImmichError && error.status===503);
    assert.equal(requests.length,2);
  }
});

test('older Immich versions without full-size support keep serving a preview', async () => {
  configure();
  handler = (req,res) => {
    if(req.url === '/api/search/metadata')json(res,[asset()]);
    else if(req.url?.endsWith('size=fullsize'))res.writeHead(400).end();
    else res.writeHead(200,{'content-type':'image/jpeg'}).end('preview');
  };
  assert.equal(await (await fetchImmichImage('alice/summer.jpg','fullsize')).text(),'preview');
});


test('semantic search confines library and exact paths, preserves rank, and caches across gallery pages', async () => {
  configure();
  const other = photo('bob/another.jpg');
  handler = (req, res, body) => {
    assert.equal(req.url, '/api/search/smart');
    assert.equal(body.query, 'friends by the sea');
    assert.equal(body.language, 'en');
    assert.deepEqual(body.filter.libraryId, { eq: LIBRARY });
    assert.deepEqual(body.filter.originalPath.in, ['/external/shared photos/alice/summer.jpg', '/external/shared photos/bob/another.jpg']);
    assert.deepEqual(body.filter.personIds.all, [ASSET]);
    assert.equal(body.size, 1000);
    json(res, [asset('/external/shared photos/bob/another.jpg', { id: '33333333-3333-4333-8333-333333333333' }), asset('/private/secret.jpg'), asset(undefined, { libraryId: 'another-library' }), asset()]);
  };
  const options = { mode: 'semantic' as const, language: 'en', filter: { personIds: { all: [ASSET] }, or: [{ city: { eq: 'Paris' } }, { country: { eq: 'France' } }] } };
  const result = await searchCollection([photo(), other], 'friends by the sea', options);
  assert.deepEqual(result.photos.map(photo => photo.id), [other.id, photo().id]);
  assert.equal(result.truncated, false);
  await searchCollection([photo(), other], 'friends by the sea', options);
  assert.equal(requests.length, 1);
});

test('filters cannot widen a collection, original-path restrictions intersect, and metadata cursors are followed', async () => {
  configure();
  let page = 0;
  handler = (req, res, body) => {
    assert.equal(req.url, '/api/search/metadata');
    assert.deepEqual(body.filter.originalPath, { in: ['/external/shared photos/alice/summer.jpg'], startsWith: '/external/' });
    assert.deepEqual(body.filter.libraryId, { eq: LIBRARY });
    page++;
    if (page === 1) json(res, [], { nextCursor: 'next-page' });
    else { assert.equal(body.cursor, 'next-page'); json(res, [asset()]); }
  };
  const result = await searchCollection([photo()], '', { mode: 'semantic', filter: { originalPath: { in: ['/private/no.jpg', '/external/shared photos/alice/summer.jpg'], startsWith: '/external/' } } });
  assert.equal(result.photos.length, 1);
  assert.equal(requests.length, 2);
  const forbidden = await searchCollection([photo()], '', { mode: 'metadata', filter: { libraryId: { eq: ASSET } } });
  assert.equal(forbidden.photos.length, 0);
  assert.equal(requests.length, 2);
});

test('people and face coordinates are discovered only from shared assets, with sanitized responses', async () => {
  configure();
  handler = (req, res, body) => {
    if (req.url === '/api/search/metadata') {
      assert.equal(body.withPeople, true);
      json(res, [asset(undefined, { people: [{ id: ASSET, name: 'Alice', thumbnailPath: '/private/portrait' }, { id: LIBRARY, name: 'Hidden person', isHidden: true }] }), asset('/private/other.jpg', { people: [{ id: LIBRARY, name: 'Private outsider' }] })]);
    } else {
      assert.equal(req.url, `/api/faces?id=${ASSET}`);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify([{ imageWidth: 1600, imageHeight: 900, boundingBoxX1: 100, boundingBoxX2: 300, boundingBoxY1: 150, boundingBoxY2: 350, person: { id: ASSET, name: 'Alice', thumbnailPath: '/private/portrait' } }]));
    }
  };
  const people = await collectionPeople([photo()]);
  assert.equal(people.length, 1);
  assert.equal(people[0].name, 'Alice');
  assert.equal(people[0].photoId, photo().id);
  assert.equal(people[0].face?.boundingBoxX1, 100);
  assert(!JSON.stringify(people).includes('private'));
  assert(!JSON.stringify(people).includes('Hidden'));
  assert.equal(requests.length, 2);
  await collectionPeople([photo()]);
  assert.equal(requests.length, 2, 'both collection people and face coordinates are cached');
});

test('people names are returned without waiting for portrait requests or fetching EXIF', async () => {
  configure();
  handler = (req, res, body) => {
    assert.equal(req.url, '/api/search/metadata', 'the fast names request must never fetch faces');
    assert.equal(body.withExif, false);
    json(res, [asset(undefined, { people: [{ id: ASSET, name: 'Alice' }] })]);
  };
  const people = await collectionPeople([photo()], undefined, false);
  assert.equal(people[0].name, 'Alice');
  assert.equal(people[0].count, 1);
  assert.equal(people[0].face, undefined);
  assert.equal(requests.length, 1);
});

test('people filters work with a restricted key even if face crops are unavailable', async () => {
  configure();
  handler = (req, res) => req.url === '/api/search/metadata' ? json(res, [asset(undefined, { people: [{ id: ASSET, name: 'Alice' }] })]) : res.writeHead(403).end();
  const people = await collectionPeople([photo()]);
  assert.equal(people.length, 1);
  assert.equal(people[0].face, undefined);
});

test('filename search remains local and unavailable semantic search never silently searches filenames', async () => {
  configure();
  const local = await searchCollection([photo()], 'SUMMER', { mode: 'filename' });
  assert.equal(local.photos.length, 1);
  assert.equal(requests.length, 0);
  handler = (_req, res) => res.writeHead(503).end('upstream private detail');
  await assert.rejects(searchCollection([photo()], 'summer', { mode: 'semantic' }), (error: any) => error.status === 503 && !error.message.includes('private'));
  configure();
  handler = (_req, res) => json(res, [asset()]);
  await assert.rejects(searchCollection([photo()], '', { mode: 'semantic', queryAssetId: LIBRARY }), (error: any) => error.status === 400 && error.message.includes('shared collection'));
  assert.equal(requests.length, 1, 'an external reference is rejected before any smart search');
});


test('an old search cannot replace cached assets after the Immich connection changes', async () => {
  configure();
  let finishOld!: () => void, started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  handler = (_req, res) => { finishOld = () => json(res, [asset()]); started(); };
  const oldSearch = searchCollection([photo()], 'an old scene', { mode: 'semantic' });
  await began;
  configure();
  const current = '33333333-3333-4333-8333-333333333333';
  handler = (req, res) => {
    if (req.url === '/api/search/metadata') return json(res, [asset(undefined, { id: current })]);
    assert.equal(req.url, `/api/assets/${current}/thumbnail?size=thumbnail`);
    res.writeHead(200, { 'content-type': 'image/webp' }).end('current-image');
  };
  await enrichPhotos([photo()]);
  finishOld();
  await oldSearch;
  assert.equal(await (await fetchImmichImage('alice/summer.jpg', 'thumbnail')).text(), 'current-image');
});
