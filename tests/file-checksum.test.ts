import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { fileChecksum } from '../src/lib/file-checksum';

test('preflight hashes empty, small and multi-chunk files without reading the whole file', async () => {
  for (const size of [0, 17, 3 * 1024 * 1024 + 97]) {
    const bytes = randomBytes(size);
    const file = new Blob([bytes]);
    file.arrayBuffer = () => { throw new Error('Whole-file read is forbidden'); };
    assert.equal(await fileChecksum(file), createHash('sha256').update(bytes).digest('hex'));
  }
});

test('hashing respects cancellation before starting and between chunks', async () => {
  const abort = new AbortController();
  const file = new Blob([new Uint8Array(2 * 1024 * 1024)]);
  const slice = file.slice.bind(file);
  file.slice = (...args) => { abort.abort(); return slice(...args); };
  await assert.rejects(fileChecksum(file, abort.signal), /abort/i);
  await assert.rejects(fileChecksum(file, abort.signal), /abort/i);
});
