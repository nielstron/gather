import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

let directory: string, origin: string, token: string, server: Server, app: ChildProcess;
const basePath = process.env.GATHER_BASE_PATH || '';
let scans = 0;
let appLog = '';
const indexed = new Map<string, string>();
const images = new Map<string, Buffer>();
const dimensions = new Map<string, { width: number; height: number }>();
let thumbnailGate: Promise<void> | undefined;
let heldThumbnails = 0, peakHeldThumbnails = 0;
const libraryId = 'cb34e6a2-f3ec-4567-bbbb-000000000001';

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}
async function indexFiles() {
  for (const folder of await readdir(path.join(directory, 'photos'))) {
    for (const filename of await readdir(path.join(directory, 'photos', folder))) {
      if (filename.startsWith('.')) continue;
      const relative = `${folder}/${filename}`;
      const hex = createHash('sha256').update(relative).digest('hex');
      const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4000-8000-${hex.slice(12, 24)}`;
      indexed.set(`/external/gather/${relative}`, id);
      const image = await readFile(path.join(directory, 'photos', relative));
      images.set(id, image);
      const metadata = await sharp(image).metadata();
      dimensions.set(id, { width: metadata.width!, height: metadata.height! });
    }
  }
}

test.beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'gather-browser-'));
  process.env.PHOTO_ROOT = path.join(directory, 'photos');
  process.env.DATA_ROOT = path.join(directory, 'data');
  const auth = await import('../src/lib/server/auth');
  token = auth.createShareLink();
  auth.createMember('Host', 'host');
  auth.createMember('Bob', 'bob');
  const colors = ['#476a81', '#b1ad86', '#c58f72'];
  const sizes = [{ width: 900, height: 600 }, { width: 400, height: 700 }, { width: 1200, height: 240 }];
  for (let index = 0; index < colors.length; index++) {
    const photo = await sharp({ create: { ...sizes[index], channels: 3, background: colors[index] } }).jpeg().toBuffer();
    const filename = path.join(directory, 'photos', index === 2 ? 'bob' : 'host', `weekend-${index}.jpg`);
    await writeFile(filename, photo);
    const modifiedAt = new Date(index === 2 ? '2024-01-02T12:00:00Z' : `2024-01-03T${12 + index}:00:00Z`);
    await utimes(filename, modifiedAt, modifiedAt);
  }
  await indexFiles();
  server = createServer(async (request, response) => {
    try {
      const key = request.headers['x-api-key'];
      if (request.url === `/api/libraries/${libraryId}/scan/path` && request.method === 'POST') {
        if (key !== 'test-scan-key') { response.writeHead(403).end(); return; }
        scans++; await indexFiles(); response.writeHead(204).end(); return;
      }
      if (key !== 'test-preview-key') { response.writeHead(401).end(); return; }
      if (request.url === '/api/search/metadata') {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        const paths = body.filter?.originalPath?.in || [body.originalPath];
        const items = paths.filter((original: string) => indexed.has(original)).map((originalPath: string) => {
          const id = indexed.get(originalPath)!;
          return { id, originalPath, libraryId, ...dimensions.get(id), thumbhash: 'ready' };
        });
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ assets: { items, nextCursor: null } })); return;
      }
      const id = request.url?.match(/^\/api\/assets\/([^/]+)\/thumbnail\?size=(thumbnail|preview)$/)?.[1];
      if (id && images.has(id)) {
        const gate = thumbnailGate;
        if (gate) { heldThumbnails++; peakHeldThumbnails = Math.max(peakHeldThumbnails, heldThumbnails); try { await gate; } finally { heldThumbnails--; } }
        response.writeHead(200, { 'content-type': 'image/jpeg' }).end(images.get(id)); return; }
      response.writeHead(404).end();
    } catch { response.writeHead(500).end(); }
  });
  const immichPort = await listen(server);
  const portProbe = createServer();
  const port = await listen(portProbe);
  await new Promise<void>((resolve) => portProbe.close(() => resolve()));
  origin = `http://127.0.0.1:${port}`;
  app = spawn(process.execPath, ['build'], { cwd: process.cwd(), env: { ...process.env,
    NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), ORIGIN: origin, COOKIE_SECURE: 'false',
    BODY_SIZE_LIMIT: '52M', IMMICH_URL: `http://127.0.0.1:${immichPort}`, IMMICH_API_KEY: 'test-preview-key',
    IMMICH_SCAN_API_KEY: 'test-scan-key', IMMICH_LIBRARY_ID: libraryId, IMMICH_PHOTO_ROOT: '/external/gather'
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  app.stdout?.on('data', (chunk) => { appLog += chunk; });
  app.stderr?.on('data', (chunk) => { appLog += chunk; });
  await expect.poll(async () => {
    if (app.exitCode !== null) throw new Error(appLog);
    try { return (await fetch(`${origin}${basePath}/api/health`)).status; } catch { return 0; }
  }, { timeout: 15_000 }).toBe(200);
});

test.afterAll(async () => {
  if (app && app.exitCode === null) {
    app.kill('SIGTERM');
    await new Promise<void>((resolve) => { app.once('exit', () => resolve()); setTimeout(resolve, 2000).unref(); });
  }
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (directory) await rm(directory, { recursive: true, force: true });
});

test('shared link, editable names, private gallery, Immich scan, uploads and original downloads', async ({ page, browser, request }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  expect((await request.get(`${origin}${basePath}/api/photos`)).status()).toBe(401);
  const csrf = await request.post(`${origin}${basePath}/api/join`, { data: { token, name: 'Alice' }, headers: { origin: 'https://attacker.invalid' } });
  expect(csrf.status()).toBe(403);
  await page.goto(`${origin}${basePath}/#share=${token}`);
  await page.getByLabel('Your name', { exact: true }).fill('Alice');
  await page.getByRole('button', { name: 'Join collection', exact: true }).click();
  await expect(page.getByRole('button', { name: 'All photos', exact: false }).first()).toBeVisible();
  await expect(page.locator('.photo-tile img')).toHaveCount(3);
  await expect.poll(() => page.locator('.photo-tile img').evaluateAll((images) => images.every((image) => (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
  await expect(page.locator('.timeline-group')).toHaveCount(2);
  await page.getByLabel('Sort photos').selectOption('name');
  await expect(page.locator('.timeline-group')).toHaveCount(1);
  await expect.poll(() => page.locator('.photo-open img').evaluateAll(images => images.map(image => image.getAttribute('alt')))).toEqual(['weekend-0.jpg', 'weekend-1.jpg', 'weekend-2.jpg']);
  await page.getByRole('button', { name: 'Sort descending', exact: true }).click();
  await expect.poll(() => page.locator('.photo-open img').evaluateAll(images => images.map(image => image.getAttribute('alt')))).toEqual(['weekend-2.jpg', 'weekend-1.jpg', 'weekend-0.jpg']);

  await expect(page.locator('.timeline-date')).toHaveCount(0);
  await page.getByLabel('Sort photos').selectOption('newest');
  await expect(page.locator('.timeline-group')).toHaveCount(2);
  await expect(page.locator('.photo-open img').first()).toHaveAttribute('alt', 'weekend-1.jpg');
  await page.getByRole('button', { name: 'Sort ascending', exact: true }).click();
  await expect(page.locator('.photo-open img').first()).toHaveAttribute('alt', 'weekend-2.jpg');
  // Sorting applies to the whole collection before page slicing.
  const firstOldest = await (await page.request.get(`${origin}${basePath}/api/photos?sort=date&direction=asc&limit=1`)).json();
  expect(firstOldest.photos.map((photo: { name: string }) => photo.name)).toEqual(['weekend-2.jpg']);
  const secondByName = await (await page.request.get(`${origin}${basePath}/api/photos?sort=name&direction=desc&offset=1&limit=1`)).json();
  expect(secondByName.photos.map((photo: { name: string }) => photo.name)).toEqual(['weekend-1.jpg']);
  await page.getByRole('button', { name: 'Sort descending', exact: true }).click();
  await expect(page.locator('.photo-open img').first()).toHaveAttribute('alt', 'weekend-1.jpg');

  const selection = page.getByRole('checkbox', { name: 'Select weekend-0.jpg', exact: true });
  await selection.check();
  await expect(page.locator('.selection-bar')).toContainText('1 selected');
  await expect(page.getByRole('button', { name: 'Download originals', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await expect(selection).not.toBeChecked();
  await expect(page.locator('.selection-bar')).toHaveCount(0);
  expect(page.url()).not.toContain(token);
  const response = await page.request.get(`${origin}${basePath}/api/photos`);
  const listing = await response.json();
  expect(listing.photos).toHaveLength(3);
  expect(JSON.stringify(listing)).not.toContain('test-preview-key');
  const aliceFolder = listing.folders.find((folder: { name: string }) => folder.name === 'Alice').folder;
  await page.locator('.photo-open').first().click();
  await expect(page.locator('.pswp')).toBeVisible();
  await expect(page.locator('.pswp__button--download-original')).toBeVisible();
  await expect(page.locator('.pswp')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('.pswp')).toHaveCount(0);

  const payload = await sharp({ create: { width: 320, height: 240, channels: 3, background: '#9dbdaf' } }).png().toBuffer();
  // Uploads must queue previews on the server even when the browser cannot request a scan.
  await page.route('**/api/immich/scan', (route) => route.abort());
  await page.locator('input[type="file"]').setInputFiles({ name: 'new-memory.png', mimeType: 'image/png', buffer: payload });
  await expect.poll(async () => {
    try { return (await readFile(path.join(directory, 'photos', aliceFolder, 'new-memory.png'))).equals(payload); } catch { return false; }
  }).toBe(true);
  await expect.poll(() => scans).toBe(1);
  await expect.poll(async () => (await (await page.request.get(`${origin}${basePath}/api/photos`)).json()).total).toBe(4);
  const updated = await (await page.request.get(`${origin}${basePath}/api/photos`)).json();
  const uploaded = updated.photos.find((photo: { name: string }) => photo.name === 'new-memory.png');
  expect(uploaded.folder).toBe(aliceFolder);
  const download = await page.request.get(`${origin}${basePath}/api/media/${uploaded.id}?kind=original`);
  expect((await download.body()).equals(payload)).toBe(true);
  const zip = await page.request.post(`${origin}${basePath}/api/download`, { headers: { origin }, data: { ids: updated.photos.map((photo: { id: string }) => photo.id) } });
  expect(zip.status()).toBe(200);
  expect(zip.headers()['content-type']).toBe('application/zip');
  const zipBody = await zip.body();
  expect(zipBody.subarray(0, 2).toString()).toBe('PK');
  expect(zipBody.includes(Buffer.from(`${aliceFolder}/new-memory.png`))).toBe(true);
  const traversal = Buffer.from('../secret.jpg').toString('base64url');
  expect((await page.request.get(`${origin}${basePath}/api/media/${traversal}?kind=original`)).status()).toBe(400);

  const bob = await browser.newContext();
  const login = await bob.request.post(`${origin}${basePath}/api/join`, { headers: { origin }, data: { token, name: 'Bob' } });
  expect(login.status()).toBe(200);
  const bobFolder = (await login.json()).user.folder;
  expect(bobFolder).not.toBe('bob');
  const bobUpload = await bob.request.post(`${origin}${basePath}/api/upload?folder=alice`, { headers: { origin, 'x-filename': 'bobs-photo.png', 'content-type': 'application/octet-stream' }, data: await sharp({ create: { width: 320, height: 240, channels: 3, background: '#9dbdb0' } }).png().toBuffer() });
  expect(bobUpload.status()).toBe(201);
  expect((await bobUpload.json()).photo.folder).toBe(bobFolder);
  expect((await bob.request.get(`${origin}${basePath}/api/media/${uploaded.id}?kind=original`)).status()).toBe(200);
  await bob.close();

  await page.getByRole('button', { name: 'Close uploads', exact: true }).click();
  await page.getByRole('button', { name: 'Change name for Alice', exact: true }).click();
  await page.getByRole('dialog').getByRole('textbox').fill('Alicia');
  await page.getByRole('button', { name: 'Save name', exact: true }).click();
  await expect.poll(async () => {
    const data = await (await page.request.get(`${origin}${basePath}/api/photos`)).json();
    return data.photos.find((photo: { name: string }) => photo.name === 'new-memory.png')?.owner;
  }).toBe('Alicia');
  expect((await readFile(path.join(directory, 'photos', aliceFolder, 'new-memory.png'))).equals(payload)).toBe(true);
  await page.reload();
  await expect(page.getByRole('region', { name: 'Photo collection', exact: true })).toBeVisible();

  await page.screenshot({ path: testInfo.outputPath('gallery-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect.poll(() => page.locator('.photo-tile').evaluateAll((tiles) => tiles.every((tile) => {
    const box = tile.getBoundingClientRect();
    const grid = tile.closest('.photo-grid')!.getBoundingClientRect();
    const image = tile.querySelector('img');
    return box.width > 0 && box.height > 0 && box.left >= grid.left - 1 && box.right <= grid.right + 1
      && box.top >= grid.top - 1 && box.bottom <= grid.bottom + 1
      && (image === null || (image.naturalWidth > 0
        && Math.abs(box.width / box.height - image.naturalWidth / image.naturalHeight) < 0.02));
  }))).toBe(true);
  await page.waitForTimeout(200);
  await page.screenshot({ path: testInfo.outputPath('gallery-mobile.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});


test('administrator configures a collection and invitations through the UI', async ({ page, request }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const adminUrl = `${origin}${basePath}/admin`;
  expect((await request.get(`${origin}${basePath}/api/admin/config`)).status()).toBe(401);
  await page.goto(adminUrl);
  await expect(page.getByRole('heading', { name: 'Make it yours.' })).toBeVisible();
  const setup = (await readFile(path.join(directory, 'data', 'admin-setup-token'), 'utf8')).trim();
  await page.goto(`${adminUrl}#setup=${setup}`);
  await page.reload();
  // A reload intentionally clears a token removed from the address bar; it can also be pasted.
  await page.getByLabel('Private setup token').fill(setup);
  await page.getByLabel('Administrator password', { exact: true }).fill('a-private-admin-password');
  await page.getByRole('button', { name: 'Create administrator', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your collection, your way.' })).toBeVisible();
  const cookies = await page.context().cookies();
  expect(cookies.find(cookie => cookie.name === 'gather_admin')?.path).toBe(basePath || '/');
  await page.getByLabel('Collection name', { exact: true }).fill('A trip to remember');
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Settings saved.');
  const saved = await (await page.request.get(`${origin}${basePath}/api/admin/config`)).json();
  expect(saved.settings.collectionName).toBe('A trip to remember');
  expect(saved.settings.immichApiKey).toBeUndefined();
  expect(saved.settings.immichScanApiKey).toBeUndefined();
  await page.getByRole('button', { name: 'Choose a different folder' }).click();
  await expect(page.getByRole('button', { name: '▱ host →', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'People & invitations', exact: true }).click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Replace shared link', exact: true }).click();
  const invitation = page.getByRole('textbox', { name: 'Generated invitation link' });
  await expect(invitation).toHaveValue(new RegExp(`${basePath}/#share=`));
  await page.getByLabel('Display name', { exact: true }).fill('Niels');
  await page.getByLabel('Upload folder', { exact: true }).fill('Niels');
  await page.getByRole('button', { name: 'Create personal invitation', exact: true }).click();
  await expect(invitation).toHaveValue(new RegExp(`${basePath}/#invite=`));
  await expect(page.getByText('Niels/', { exact: false })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('admin-invitations-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('admin-invitations-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  expect((await page.request.get(`${origin}${basePath}/api/admin/config`)).status()).toBe(401);
  expect(errors).toEqual([]);
});


test('a stalled gallery request stops loading and offers a working retry', async ({ page }) => {
  const auth = await import('../src/lib/server/auth');
  const invitation = auth.createMember('Slow connection', 'slow-connection');
  let unblock!: () => void;
  let requested!: () => void;
  const pending = new Promise<void>(resolve => { requested = resolve; });
  await page.clock.install();
  await page.route('**/api/photos?*', async route => {
    requested();
    await new Promise<void>(resolve => { unblock = resolve; });
    await route.abort().catch(() => {});
  });
  await page.goto(`${origin}${basePath}/#invite=${invitation.token}`);
  await pending;
  await page.clock.fastForward(30_001);
  await expect(page.getByRole('alert')).toContainText('Loading is taking longer than expected');
  await expect(page.getByText('Gathering your photos…', { exact: true })).toHaveCount(0);
  unblock();
  await page.unrouteAll({ behavior: 'wait' });
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.locator('.photo-tile').first()).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});


test('two uploads start together instead of waiting for each other', async ({ page }) => {
  const auth = await import('../src/lib/server/auth');
  const invitation = auth.createMember('Parallel uploads', 'parallel-uploads');
  await page.goto(`${origin}${basePath}/#invite=${invitation.token}`);
  await expect(page.locator('.photo-tile').first()).toBeVisible();
  const payload = await sharp({ create: { width: 20, height: 20, channels: 3, background: `#${createHash('sha256').update(test.info().title).digest('hex').slice(0,6)}` } }).png().toBuffer();
  let started = 0;
  let release!: () => void;
  const bothStarted = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/upload', async route => {
    if (++started === 2) release();
    await bothStarted;
    await route.continue();
  });
  await page.locator('input[type="file"]').setInputFiles([
    { name: 'parallel-one.png', mimeType: 'image/png', buffer: payload },
    { name: 'parallel-two.png', mimeType: 'image/png', buffer: await sharp({create:{width:21,height:20,channels:3,background:'#476a81'}}).png().toBuffer() }
  ]);
  await expect.poll(() => started).toBe(2);
  await expect.poll(async () => {
    const result = await (await page.request.get(`${origin}${basePath}/api/photos`)).json();
    return result.photos.filter((photo: { name: string }) => photo.name.startsWith('parallel-')).length;
  }).toBe(2);
});

test('interrupted uploads retry automatically and a lost success response does not duplicate the file', async ({ page }) => {
  const auth = await import('../src/lib/server/auth');
  const invitation = auth.createMember('Retry uploads', 'retry-uploads');
  await page.goto(`${origin}${basePath}/#invite=${invitation.token}`);
  await expect(page.locator('.photo-tile').first()).toBeVisible();
  const payload = await sharp({ create: { width: 20, height: 20, channels: 3, background: `#${createHash('sha256').update(test.info().title).digest('hex').slice(0,6)}` } }).png().toBuffer();
  const identifiers: string[] = [];
  let attempts = 0;
  await page.route('**/api/upload', async route => {
    identifiers.push(route.request().headers()['x-upload-id']);
    attempts++;
    if (attempts === 1) { await route.abort(); return; }
    if (attempts === 2) {
      const saved = await route.fetch();
      expect(saved.status()).toBe(201);
      await route.abort(); // The file exists, but its success response is lost.
      return;
    }
    await route.continue();
  });
  await page.locator('input[type="file"]').setInputFiles({ name: 'automatic-retry.png', mimeType: 'image/png', buffer: payload });
  await expect(page.locator('.upload-panel')).toContainText('Retrying automatically');
  await expect(page.locator('.upload-panel')).toContainText('Saved · Immich preview processing', { timeout: 15_000 });
  expect(attempts).toBe(3);
  expect(new Set(identifiers).size).toBe(1);
  expect((await readdir(path.join(directory, 'photos', 'retry-uploads'))).filter(name => !name.startsWith('.'))).toEqual(['automatic-retry.png']);
  expect((await readFile(path.join(directory, 'photos', 'retry-uploads', 'automatic-retry.png'))).equals(payload)).toBe(true);
  const collision = await page.request.post(`${origin}${basePath}/api/upload`, { headers: { origin, 'x-filename': 'other.png', 'x-upload-id': identifiers[0], 'x-upload-size': String(payload.length), 'content-type': 'image/png' }, data: payload });
  expect(collision.status()).toBe(409);
  const duplicateHeaders = { origin, 'x-filename': 'concurrent-retry.png', 'x-upload-id': 'concurrent-retry-identifier', 'x-upload-size': String(payload.length), 'content-type': 'image/png' };
  const concurrent = await Promise.all([0, 1].map(() => page.request.post(`${origin}${basePath}/api/upload`, { headers: duplicateHeaders, data: payload })));
  expect(concurrent.map(response => response.status()).sort()).toEqual([200, 200]);
  expect((await readdir(path.join(directory, 'photos', 'retry-uploads'))).filter(name => name.startsWith('concurrent-retry'))).toEqual([]);
});

test('a queued automatic retry can be cancelled', async ({ page }) => {
  const auth = await import('../src/lib/server/auth');
  const invitation = auth.createMember('Cancel retry', 'cancel-retry');
  await page.clock.install();
  await page.goto(`${origin}${basePath}/#invite=${invitation.token}`);
  await expect(page.locator('.photo-tile').first()).toBeVisible();
  let attempts = 0;
  await page.route('**/api/upload', route => {
    attempts++;
    return route.fulfill({ status: 503, headers: { 'retry-after': '60' }, contentType: 'application/json', body: JSON.stringify({ error: 'Temporary outage.' }) });
  });
  await page.locator('input[type="file"]').setInputFiles({ name: 'cancel-retry.png', mimeType: 'image/png', buffer: Buffer.from('test') });
  await expect(page.locator('.upload-panel')).toContainText('Retrying automatically');
  await page.getByRole('button', { name: 'Cancel cancel-retry.png', exact: true }).click();
  await page.clock.fastForward(120_000);
  await expect(page.locator('.upload-panel')).toContainText('Cancelled');
  expect(attempts).toBe(1);
});

test('offline uploads resume when the connection returns', async ({ page, context }) => {
  const auth = await import('../src/lib/server/auth');
  const invitation = auth.createMember('Offline retry', 'offline-retry');
  await page.goto(`${origin}${basePath}/#invite=${invitation.token}`);
  await expect(page.locator('.photo-tile').first()).toBeVisible();
  const payload = await sharp({ create: { width: 20, height: 20, channels: 3, background: `#${createHash('sha256').update(test.info().title).digest('hex').slice(0,6)}` } }).png().toBuffer();
  await context.setOffline(true);
  await page.locator('input[type="file"]').setInputFiles({ name: 'offline-retry.png', mimeType: 'image/png', buffer: payload });
  await expect(page.locator('.upload-panel')).toContainText('Waiting for connection');
  await context.setOffline(false);
  await expect(page.locator('.upload-panel')).toContainText('Saved · Immich preview processing');
  expect((await readFile(path.join(directory, 'photos', 'offline-retry', 'offline-retry.png'))).equals(payload)).toBe(true);
});

test('automatic retries stop after five retries and permanent errors do not retry', async ({ page }) => {
  const auth = await import('../src/lib/server/auth');
  const invitation = auth.createMember('Retry limit', 'retry-limit');
  await page.clock.install();
  await page.goto(`${origin}${basePath}/#invite=${invitation.token}`);
  await expect(page.locator('.photo-tile').first()).toBeVisible();
  let attempts = 0;
  await page.route('**/api/upload', route => { attempts++; return route.fulfill({ status: 503, body: '{}' }); });
  await page.locator('input[type="file"]').setInputFiles({ name: 'retry-limit.png', mimeType: 'image/png', buffer: Buffer.from('test') });
  await expect.poll(() => attempts).toBe(1);
  for (let retry = 0; retry < 5; retry++) {
    await expect(page.locator('.upload-panel')).toContainText('Retrying automatically');
    await page.clock.fastForward(1000 * 2 ** retry + 1);
    await expect.poll(() => attempts).toBe(retry + 2);
  }
  await expect(page.locator('.upload-panel')).toContainText('Automatic retries exhausted');
  await page.clock.fastForward(120_000);
  expect(attempts).toBe(6);
  await page.unroute('**/api/upload');
  await page.route('**/api/upload', route => { attempts++; return route.fulfill({ status: 415, contentType: 'application/json', body: JSON.stringify({ error: 'Invalid image.' }) }); });
  await page.locator('input[type="file"]').setInputFiles({ name: 'invalid.png', mimeType: 'image/png', buffer: Buffer.from('test') });
  await expect(page.locator('.upload-panel')).toContainText('Invalid image.');
  await page.clock.fastForward(120_000);
  expect(attempts).toBe(7);
});

test('a stalled transfer retries after its inactivity timeout', async ({ page }) => {
  const auth = await import('../src/lib/server/auth');
  const invitation = auth.createMember('Stalled retry', 'stalled-retry');
  await page.clock.install();
  await page.goto(`${origin}${basePath}/#invite=${invitation.token}`);
  await expect(page.locator('.photo-tile').first()).toBeVisible();
  const payload = await sharp({ create: { width: 20, height: 20, channels: 3, background: `#${createHash('sha256').update(test.info().title).digest('hex').slice(0,6)}` } }).png().toBuffer();
  let attempts = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/upload', async route => {
    if (++attempts === 1) { await gate; await route.abort().catch(() => {}); }
    else await route.continue();
  });
  await page.locator('input[type="file"]').setInputFiles({ name: 'stalled-retry.png', mimeType: 'image/png', buffer: payload });
  await expect.poll(() => attempts).toBe(1);
  await page.clock.fastForward(90_001);
  await expect(page.locator('.upload-panel')).toContainText('Connection timed out. Retrying automatically');
  release();
  await page.clock.fastForward(1001);
  await expect(page.locator('.upload-panel')).toContainText('Saved · Immich preview processing');
  expect(attempts).toBe(2);
});


test('search remains responsive while image connections are stalled', async ({ page }) => {
  const auth = await import('../src/lib/server/auth');
  const invitation = auth.createMember('Responsive search', 'responsive-search');
  await indexFiles();
  let release!: () => void;
  thumbnailGate = new Promise<void>(resolve => { release = resolve; });
  peakHeldThumbnails = 0;
  try {
    await page.goto(`${origin}${basePath}/#invite=${invitation.token}`, {waitUntil:'domcontentloaded'});
    await expect(page.locator('.photo-tile').first()).toBeVisible();
    await expect.poll(() => heldThumbnails).toBe(2);
    const started = Date.now();
    const response = page.waitForResponse(r => r.url().includes('/api/photos?') && r.url().includes('q=no-such-photo'));
    await page.getByLabel('Search filenames').fill('no-such-photo');
    expect((await response).status()).toBe(200);
    expect(Date.now() - started).toBeLessThan(2500);
    expect(peakHeldThumbnails).toBeLessThanOrEqual(2);
    await expect(page.locator('.photo-tile')).toHaveCount(0);
  } finally { thumbnailGate = undefined; release(); }
});

test('new searches abort previous searches instead of leaving them queued', async ({ page }) => {
  const auth = await import('../src/lib/server/auth');
  const invitation = auth.createMember('Cancel search', 'cancel-search');
  await page.goto(`${origin}${basePath}/#invite=${invitation.token}`);
  await expect(page.locator('.photo-tile').first()).toBeVisible();
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { started = resolve; });
  let aborted = false;
  page.on('requestfailed', request => { if(request.url().includes('q=old-search')) aborted = true; });
  await page.route('**/api/photos?*', async route => {
    if (!route.request().url().includes('q=old-search')) { await route.continue(); return; }
    started(); await gate; await route.abort().catch(() => {});
  });
  try {
    await page.getByLabel('Search filenames').fill('old-search');
    await requested;
    await page.getByLabel('Search filenames').fill('weekend');
    await expect(page.locator('.photo-tile')).toHaveCount(3);
    await expect.poll(() => aborted).toBe(true);
    await expect(page.getByRole('alert')).toHaveCount(0);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('uploading an existing file under a new name is visibly skipped', async ({ page }) => {
  const auth = await import('../src/lib/server/auth');
  const invitation = auth.createMember('Duplicate uploads', 'duplicate-uploads');
  await page.goto(`${origin}${basePath}/#invite=${invitation.token}`);
  await expect(page.locator('.photo-tile').first()).toBeVisible();
  const payload = await readFile(path.join(directory, 'photos', 'host', 'weekend-0.jpg'));
  await page.locator('input[type="file"]').setInputFiles({name:'renamed-weekend.jpg',mimeType:'image/jpeg',buffer:payload});
  await expect(page.locator('.upload-panel')).toContainText('Already in collection · skipped');
  expect((await readdir(path.join(directory, 'photos', 'duplicate-uploads'))).filter(name=>!name.startsWith('.'))).toEqual([]);
});
