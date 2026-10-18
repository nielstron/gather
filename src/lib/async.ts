/** Run independent work concurrently without flooding the filesystem or upstream API. */
export function createLimiter(concurrency: number) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('Invalid concurrency');
  let active = 0;
  const waiting: (() => void)[] = [];
  return async function limited<T>(task: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve) => {
      const start = () => { active++; resolve(); };
      if (active < concurrency) start(); else waiting.push(start);
    });
    try { return await task(); }
    finally { active--; waiting.shift()?.(); }
  };
}

/** Share a resource budget fairly; an oversized task runs alone. */
export function createWeightedLimiter(capacity: number) {
  if (!Number.isFinite(capacity) || capacity <= 0) throw new Error('Invalid capacity');
  let active = 0;
  const waiting: { cost: number; start: () => void }[] = [];
  const drain = () => {
    while (waiting.length && active + waiting[0].cost <= capacity) {
      const item = waiting.shift()!;
      active += item.cost;
      item.start();
    }
  };
  return async function limited<T>(cost: number, task: () => Promise<T>): Promise<T> {
    if (!Number.isFinite(cost) || cost <= 0) throw new Error('Invalid task cost');
    const reserved = Math.min(capacity, cost);
    await new Promise<void>(resolve => { waiting.push({ cost: reserved, start: resolve }); drain(); });
    try { return await task(); }
    finally { active -= reserved; drain(); }
  };
}

export async function mapConcurrent<T, R>(items: readonly T[], concurrency: number, task: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('Invalid concurrency');
  const result: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  let failure: unknown;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try { result[index] = await task(items[index], index); }
      catch (error) { failed = true; failure = error; }
    }
  }));
  // Drain started work before rejecting, so callers can safely release resources.
  if (failed) throw failure;
  return result;
}

/** Tasks can discover more work without occupying a worker while waiting for children. */
export async function runConcurrentQueue<T>(initial: readonly T[], concurrency: number, task: (item: T, enqueue: (item: T) => void) => Promise<void>): Promise<void> {
  const limited = createLimiter(concurrency);
  await new Promise<void>((resolve, reject) => {
    let outstanding = 0;
    let failed = false;
    let failure: unknown;
    const enqueue = (item: T) => {
      if (failed) return;
      outstanding++;
      void limited(async () => { if (!failed) await task(item, enqueue); }).catch((error) => {
        failed = true; failure = error;
      }).then(() => {
        if (--outstanding === 0) { if (failed) reject(failure); else resolve(); }
      });
    };
    for (const item of initial) enqueue(item);
    if (!outstanding) resolve();
  });
}
