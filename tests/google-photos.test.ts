import assert from 'node:assert/strict';
import { test } from 'node:test';
import { albumData, discoverGoogleAlbum, fetchGooglePhoto, googleAlbumUrl, googleFilename, googleMediaUrl } from '../src/lib/server/google-photos';

const album = 'https://photos.google.com/share/AF1Qabcdefghijklmnopqrstuv?key=abcdefghijklmnopqrstuv';
const media = (id: string) => `https://lh3.googleusercontent.com/pw/${id}`;
const row = (id: string, video = false) => [id, [media(id), 80, 60], 1, 'key', 0, 2, null, null, null, video ? { '76647426': [3000] } : {}];
function data(rows: unknown[], cursor: string | null = null, total = rows.length) {
  const meta: unknown[] = []; meta[0] = 'AF1Qabcdefghijklmnopqrstuv'; meta[1] = 'A trip together'; meta[21] = total;
  return [null, rows, cursor, meta];
}
const html = (value: unknown) => `<script>AF_initDataCallback({key: 'ds:1', hash: '2', data:${JSON.stringify(value)}, sideChannel: {}});</script>`;

function mock(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
  return ((input: string | URL | Request, init?: RequestInit) => handler(new URL(String(input)), init)) as typeof fetch;
}

test('only Google shared album links and known photo CDNs are accepted', () => {
  assert.equal(googleAlbumUrl('https://photos.app.goo.gl/Abcdefg?g_st=ic').href, 'https://photos.app.goo.gl/Abcdefg');
  assert.equal(googleAlbumUrl(album + '&tracking=removed').href, album);
  for (const url of ['http://photos.app.goo.gl/Abcdefg', 'https://127.0.0.1/album', 'https://photos.google.com.evil.test/share/AF1Qabcdefghijklmnopqrstuv', 'https://user:pass@photos.app.goo.gl/Abcdefg', 'https://photos.google.com:9443/share/AF1Qabcdefghijklmnopqrstuv', 'file:///etc/passwd']) {
    assert.throws(() => googleAlbumUrl(url));
    assert.throws(() => googleMediaUrl(url));
  }
  assert.equal(googleMediaUrl(media('photo')).hostname, 'lh3.googleusercontent.com');
  assert.throws(() => googleMediaUrl('https://lh3.googleusercontent.com.evil.test/photo'));
});

test('reads all album pages, excludes videos, and never returns a truncated preview', async () => {
  let requests = 0;
  const result = await discoverGoogleAlbum('https://photos.app.goo.gl/Abcdefg', undefined, mock((url, init) => {
    requests++;
    if (url.hostname === 'photos.app.goo.gl') return new Response(null, { status: 302, headers: { location: album } });
    if (url.pathname.includes('batchexecute')) {
      assert.equal(init?.method, 'POST');
      const payload = JSON.parse(new URLSearchParams(String(init.body)).get('f.req')!);
      assert.deepEqual(JSON.parse(payload[0][0][1]), ['AF1Qabcdefghijklmnopqrstuv', 'next-page', null, 'abcdefghijklmnopqrstuv']);
      return new Response(")]}'\n\n123\n" + JSON.stringify([['wrb.fr', 'snAcKc', JSON.stringify(data([row('two')], null, 3))]]) + '\n');
    }
    return new Response(html(data([row('one'), row('video', true)], 'next-page', 3)));
  }));
  assert.equal(result.title, 'A trip together');
  assert.deepEqual(result.photos.map(photo => photo.id), ['one', 'two']);
  assert.equal(result.unsupported, 1); assert.equal(requests, 3);
  await assert.rejects(discoverGoogleAlbum(album, undefined, mock(() => new Response(html(data([row('one')], null, 5))))), /incomplete album/);
});

test('blocks redirects and media URLs that could reach arbitrary servers', async () => {
  let requests = 0;
  await assert.rejects(discoverGoogleAlbum('https://photos.app.goo.gl/Abcdefg', undefined, mock(() => {
    requests++; return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } });
  })), /login|publicly shared/);
  assert.equal(requests, 1);
  await assert.rejects(discoverGoogleAlbum(album, undefined, mock(() => new Response(html(data([['one', ['http://127.0.0.1/private']]]))))), /unsupported photo address/);
  await assert.rejects(fetchGooglePhoto({ id: 'one', url: media('one'), modified: 1 }, new AbortController().signal, mock(() => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } }))), /login|publicly shared/);
});

test('rejects scripts, pagination cycles, oversized albums and unavailable public albums', async () => {
  assert.throws(() => albumData("AF_initDataCallback({key: 'ds:1', data:(globalThis.unsafe=true), sideChannel: {}});"), /readable shared album/);
  await assert.rejects(discoverGoogleAlbum(album, undefined, mock(() => new Response(html(data([row('one')], null, 1001))))), /smaller shared albums/);
  await assert.rejects(discoverGoogleAlbum(album, undefined, mock(url => new Response(url.pathname.includes('batchexecute') ? JSON.stringify([['wrb.fr', 'snAcKc', JSON.stringify(data([row('one')], 'same-cursor', 2))]]) : html(data([row('one')], 'same-cursor', 2))))), /pagination/);
  await assert.rejects(discoverGoogleAlbum(album, undefined, mock(() => new Response('private', { status: 403 }))), /link sharing/);
});

test('requests the Google download variant and safely preserves supplied filenames', async () => {
  const photo = { id: 'test-photo', url: media('test-photo'), modified: 1 };
  const response = await fetchGooglePhoto(photo, new AbortController().signal, mock(url => {
    assert.equal(url.pathname, '/pw/test-photo=d');
    return new Response('image', { headers: { 'content-type': 'image/jpeg', 'content-disposition': 'attachment;filename="IMG_1234.jpg"' } });
  }));
  assert.equal(googleFilename(photo, response), 'IMG_1234.jpg');
  assert.equal(googleFilename(photo, new Response(null, { headers: { 'content-type': 'image/png', 'content-disposition': "attachment; filename*=UTF-8''Road%20trip.png" } })), 'Road trip.png');
  assert.equal(googleFilename(photo, new Response(null, { headers: { 'content-type': 'image/jpeg', 'content-disposition': 'attachment;filename="../../safe.jpg"' } })), 'safe.jpg');
  assert.throws(() => googleFilename(photo, new Response('sign in', { headers: { 'content-type': 'text/html' } })), /unsupported file/);
});
