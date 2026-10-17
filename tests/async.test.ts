import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { createLimiter, mapConcurrent, runConcurrentQueue } from '../src/lib/async';

test('a shared limiter starts work in parallel while reserving freed slots for queued work', async () => {
  const limit = createLimiter(3);
  let active = 0, peak = 0;
  await Promise.all(Array.from({ length: 20 }, () => limit(async () => {
    active++; peak = Math.max(peak, active);
    await setImmediate();
    active--;
  })));
  assert.equal(peak, 3);
  assert.equal(active, 0);
});

test('parallel mapping preserves input order and drains started work before reporting failure', async () => {
  const result = await mapConcurrent([3, 2, 1], 3, async value => { await setImmediate(); return value * 2; });
  assert.deepEqual(result, [6, 4, 2]);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started: number[] = [];
  let settled = false;
  const outcome = mapConcurrent([0, 1, 2], 2, async index => {
    started.push(index);
    if (index === 0) throw new Error('failure');
    await gate;
  }).then(() => { settled = true; return undefined; }, error => { settled = true; return error; });
  await setImmediate();
  assert.equal(settled, false);
  release();
  assert.match((await outcome).message, /failure/);
  assert.deepEqual(started, [0, 1]);
});

test('directory tasks discover parallel children without deadlocking the worker pool', async () => {
  let active = 0, peak = 0;
  const visited: number[] = [];
  await runConcurrentQueue([0], 4, async (item, enqueue) => {
    active++; peak = Math.max(peak, active);
    if (item === 0) for (let child = 1; child <= 12; child++) enqueue(child);
    await setImmediate();
    visited.push(item);
    active--;
  });
  assert.equal(visited.length, 13);
  assert.equal(peak, 4);
});
