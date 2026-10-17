import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeBasePath } from '../src/lib/base-path';

test('base paths support root, nested prefixes, and trailing slash normalization', () => {
  for (const [input, expected] of [['', ''], ['/', ''], ['/gather', '/gather'], ['/gather/', '/gather'], ['/photos/trip-2026/', '/photos/trip-2026']]) {
    assert.equal(normalizeBasePath(input), expected);
  }
});

test('base paths reject origins, traversal, encoded paths, and ambiguous separators', () => {
  for (const input of ['https://example.com/gather', 'gather', '//example.com', '/a//b', '/a/../b', '/a/./b', '/a%2fb', '/a?b', '/a#b', '/a b', '/a\\b']) {
    assert.throws(() => normalizeBasePath(input), /GATHER_BASE_PATH/);
  }
});
