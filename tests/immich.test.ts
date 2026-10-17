import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { after, before, test } from 'node:test';
import { enrichPhotos, fetchImmichImage, ImmichError, requestLibraryScan } from '../src/lib/server/immich.js';
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
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  base = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  for (const key of ['IMMICH_URL', 'IMMICH_API_KEY', 'IMMICH_SCAN_API_KEY', 'IMMICH_LIBRARY_ID', 'IMMICH_PHOTO_ROOT', 'IMMICH_SCAN_MODE']) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
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


test('an unpatched Immich server never falls back to scanning the whole library', async () => {
  configure();
  handler = (_req, res) => res.writeHead(404).end();
  const result = await requestLibraryScan();
  assert.equal(result.state, 'unavailable');
  assert.match(result.message!, /folder-scan API extension/);
  assert.deepEqual(requests.map(request => request.url), [`/api/libraries/${LIBRARY}/scan/path`]);
});


test('whole-library scans require explicit operator configuration', async () => {
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
