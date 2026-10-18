import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cacheThumbnail, retainThumbnail } from '../src/lib/thumbnail-cache';

test('the viewer can retain a gallery thumbnail after its gallery element is removed', async () => {
  const gallery = cacheThumbnail('thumbnail-a', new Blob(['cached thumbnail']));
  const viewer = retainThumbnail('thumbnail-a')!;
  assert.equal(viewer.url, gallery.url);
  gallery.release();
  assert.equal(await (await fetch(viewer.url)).text(), 'cached thumbnail');
  viewer.release();
  assert.equal(retainThumbnail('thumbnail-a'), undefined);
  await assert.rejects(fetch(viewer.url));
});

test('releasing a lease twice cannot revoke a later thumbnail with the same key', async () => {
  const first = cacheThumbnail('thumbnail-b', new Blob(['first']));
  first.release();
  const second = cacheThumbnail('thumbnail-b', new Blob(['second']));
  first.release();
  assert.equal(await (await fetch(second.url)).text(), 'second');
  second.release();
});
