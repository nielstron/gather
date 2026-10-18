import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, lstat, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
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
      if (filename.startsWith('.') || !(await lstat(path.join(directory, 'photos', folder, filename))).isFile()) continue;
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
      if (request.url === '/api/search/metadata' || request.url === '/api/search/smart') {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        const paths = body.filter?.originalPath?.in || (body.originalPath ? [body.originalPath] : [...indexed.keys()]);
        const items = paths.filter((original: string) => indexed.has(original)).map((originalPath: string) => {
          const id = indexed.get(originalPath)!;
          const name = originalPath.split('/').at(-1)!;
          const person = name === 'weekend-0.jpg' ? { id: '11111111-1111-4111-8111-111111111111', name: 'Alice face' } : { id: '22222222-2222-4222-8222-222222222222', name: 'Bob face' };
          return { id, originalPath, libraryId, ...dimensions.get(id), thumbhash: 'ready', people: [person], city: name === 'weekend-0.jpg' ? 'Paris' : 'Berlin' };
        });
        let matches = items.filter((item: any) => {
          const filters = body.filter || {};
          const personIds = item.people.map((person: any) => person.id);
          return (!filters.personIds?.all || filters.personIds.all.every((id: string) => personIds.includes(id))) &&
            (!filters.personIds?.any || filters.personIds.any.some((id: string) => personIds.includes(id))) &&
            (!filters.personIds?.none || filters.personIds.none.every((id: string) => !personIds.includes(id))) &&
            (!filters.city?.eq || item.city === filters.city.eq);
        });
        if (body.query?.includes('no-such-photo')) matches = [];
        if (request.url === '/api/search/smart') matches = matches.reverse().slice(0, body.size);
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ assets: { items: matches, nextCursor: null } })); return;
      }
      const id = request.url?.match(/^\/api\/assets\/([^/]+)\/thumbnail\?size=(thumbnail|preview|fullsize)$/)?.[1];
      if (id && images.has(id)) {
        const gate = thumbnailGate;
        if (gate) { heldThumbnails++; peakHeldThumbnails = Math.max(peakHeldThumbnails, heldThumbnails); try { await gate; } finally { heldThumbnails--; } }
        const size = new URL(request.url!, 'http://localhost').searchParams.get('size');
        const image = await sharp(images.get(id)!).resize({width:size==='thumbnail'?200:600,withoutEnlargement:true}).jpeg().toBuffer();
        response.writeHead(200, { 'content-type': 'image/jpeg' }).end(image); return; }
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
  await page.getByRole('button', { name: 'Sort photos', exact: true }).click();
  await expect(page.getByRole('menu', { name: 'Sort photos' }).getByRole('menuitemradio')).toHaveText(['Ascending', 'Descending', 'Filename', 'Date/time']);
  await page.getByRole('menuitemradio', { name: 'Ascending', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Filename', exact: true }).click();
  await expect(page.locator('.timeline-group')).toHaveCount(1);
  await expect.poll(() => page.locator('.photo-open img').evaluateAll(images => images.map(image => image.getAttribute('alt')))).toEqual(['weekend-0.jpg', 'weekend-1.jpg', 'weekend-2.jpg']);
  await page.getByRole('menuitemradio', { name: 'Descending', exact: true }).click();
  await expect.poll(() => page.locator('.photo-open img').evaluateAll(images => images.map(image => image.getAttribute('alt')))).toEqual(['weekend-2.jpg', 'weekend-1.jpg', 'weekend-0.jpg']);

  await expect(page.getByRole('button', { name: /^Sort (ascending|descending)$/ })).toHaveCount(0);
  await expect(page.locator('.timeline-date')).toHaveCount(0);
  await page.getByRole('menuitemradio', { name: 'Date/time', exact: true }).click();
  await expect(page.locator('.timeline-group')).toHaveCount(2);
  await expect(page.locator('.photo-open img').first()).toHaveAttribute('alt', 'weekend-1.jpg');
  await page.getByRole('menuitemradio', { name: 'Ascending', exact: true }).click();
  await expect(page.locator('.photo-open img').first()).toHaveAttribute('alt', 'weekend-2.jpg');
  // Sorting applies to the whole collection before page slicing.
  const firstOldest = await (await page.request.get(`${origin}${basePath}/api/photos?sort=date&direction=asc&limit=1`)).json();
  expect(firstOldest.photos.map((photo: { name: string }) => photo.name)).toEqual(['weekend-2.jpg']);
  const secondByName = await (await page.request.get(`${origin}${basePath}/api/photos?sort=name&direction=desc&offset=1&limit=1`)).json();
  expect(secondByName.photos.map((photo: { name: string }) => photo.name)).toEqual(['weekend-1.jpg']);
  await page.getByRole('menuitemradio', { name: 'Descending', exact: true }).click();
  await expect(page.locator('.photo-open img').first()).toHaveAttribute('alt', 'weekend-1.jpg');

  await expect(page.getByRole('menuitemradio', { name: 'Date/time', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('menuitemradio', { name: 'Descending', exact: true })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu', { name: 'Sort photos' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sort photos', exact: true })).toBeFocused();
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
  await expect(page.locator('.profile-dialog')).not.toBeVisible();
  await expect.poll(() => page.evaluate(() => !history.state?.['sveltekit:states']?.modalIds?.length)).toBe(true);
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
  await expect(page.locator('.upload-panel')).toContainText('Already in collection · skipped', { timeout: 15_000 });
  expect(attempts).toBe(2);
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
  await page.setViewportSize({ width: 1280, height: 1200 });
  try {
    await page.goto(`${origin}${basePath}/#invite=${invitation.token}`, {waitUntil:'domcontentloaded'});
    await expect(page.locator('.photo-tile').first()).toBeVisible();
    await expect.poll(() => heldThumbnails).toBe(2);
    const started = Date.now();
    const response = page.waitForResponse(r => r.url().includes('/api/photos?') && r.url().includes('q=no-such-photo'));
    await page.getByLabel('Search photos').fill('no-such-photo');
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
    await page.getByLabel('Search photos').fill('old-search');
    await requested;
    const latestReply = page.waitForResponse(response => response.url().includes('/api/photos?') && new URL(response.url()).searchParams.get('q') === 'weekend');
    await page.getByLabel('Search photos').fill('weekend');
    const latest = await (await latestReply).json();
    await expect(page.locator('.photo-tile')).toHaveCount(latest.photos.length);
    await expect.poll(() => aborted).toBe(true);
    await expect(page.getByRole('alert')).toHaveCount(0);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('uploading an existing file under a new name sends only its hash and skips the file transfer', async ({ page }) => {
  const auth = await import('../src/lib/server/auth');
  const invitation = auth.createMember('Duplicate uploads', 'duplicate-uploads');
  await page.goto(`${origin}${basePath}/#invite=${invitation.token}`);
  await expect(page.locator('.photo-tile').first()).toBeVisible();
  const payload = await readFile(path.join(directory, 'photos', 'host', 'weekend-0.jpg'));
  let transfers = 0;
  const checks: unknown[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === `${basePath}/api/upload`) transfers++;
    if (new URL(request.url()).pathname === `${basePath}/api/upload/check`) checks.push(request.postDataJSON());
  });
  await page.locator('input[type="file"]').setInputFiles({name:'renamed-weekend.jpg',mimeType:'image/jpeg',buffer:payload});
  await expect(page.locator('.upload-panel')).toContainText('Already in collection · skipped');
  expect(transfers).toBe(0);
  expect(checks).toEqual([{ checksum: createHash('sha256').update(payload).digest('hex'), size: payload.length }]);
  expect((await readdir(path.join(directory, 'photos', 'duplicate-uploads'))).filter(name=>!name.startsWith('.'))).toEqual([]);
});


test('the viewer reuses cached thumbnails on opening and swiping, then upgrades on zoom without moving the image', async ({ page }) => {
  const auth = await import('../src/lib/server/auth');
  const invitation = auth.createMember('Progressive viewer', 'progressive-viewer');
  await page.setViewportSize({width:390,height:844});
  await page.goto(`${origin}${basePath}/#invite=${invitation.token}`);
  const photo = (name: string) => page.locator('.photo-open').filter({has:page.locator(`img[alt="${name}"]`)});
  for(const name of ['weekend-2.jpg','weekend-0.jpg']) {
    await photo(name).scrollIntoViewIfNeeded();
    await expect.poll(()=>photo(name).locator('img').evaluate((image:HTMLImageElement)=>image.naturalWidth)).toBeGreaterThan(0);
  }
  const firstThumbnail = await photo('weekend-0.jpg').locator('img').getAttribute('src');
  const nextThumbnail = await photo('weekend-2.jpg').locator('img').getAttribute('src');
  let releasePreview!: () => void, releaseFull!: () => void;
  const previewGate = new Promise<void>(resolve=>{releasePreview=resolve;});
  const fullGate = new Promise<void>(resolve=>{releaseFull=resolve;});
  let fullRequests=0;
  await page.route('**/api/media/**',async route=>{
    const kind=new URL(route.request().url()).searchParams.get('kind');
    if(kind==='preview')await previewGate;
    if(kind==='fullsize'){fullRequests++;await fullGate;}
    await route.continue().catch(()=>{});
  });
  const active = page.locator('.pswp__item[aria-hidden="false"] img.pswp__img:not(.pswp__img--placeholder)');
  try {
    await photo('weekend-0.jpg').click();
    await expect(active).toHaveAttribute('src',firstThumbnail!);
    await expect.poll(()=>active.evaluate((image:HTMLImageElement)=>image.naturalWidth)).toBeGreaterThan(0);
    const thumbnailWidth=await active.evaluate((image:HTMLImageElement)=>image.naturalWidth);
    expect(fullRequests).toBe(0);
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.pswp__photo-caption')).toContainText('weekend-2.jpg');
    await expect(active).toHaveAttribute('src',nextThumbnail!);
    releasePreview();
    await expect(active).toHaveAttribute('data-resolution','preview');
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('.pswp__photo-caption')).toContainText('weekend-0.jpg');
    await expect(active).toHaveAttribute('data-resolution','preview');
    const previewSource=await active.getAttribute('src');
    await expect.poll(()=>active.evaluate((image:HTMLImageElement)=>image.naturalWidth)).toBeGreaterThan(thumbnailWidth);
    const previewWidth=await active.evaluate((image:HTMLImageElement)=>image.naturalWidth);
    expect(previewWidth).toBeGreaterThan(thumbnailWidth);
    await page.getByRole('button',{name:'Zoom',exact:true}).click();
    await expect.poll(()=>fullRequests).toBe(1);
    await expect(active).toHaveAttribute('src',previewSource!);
    // Wait for the user's zoom animation before testing the resolution-only swap.
    await page.waitForTimeout(400);
    const transform=await active.evaluate(image=>(image.parentElement as HTMLElement).style.transform);
    releaseFull();
    await expect(active).toHaveAttribute('data-resolution','fullsize');
    await expect.poll(()=>active.evaluate((image:HTMLImageElement)=>image.naturalWidth)).toBeGreaterThan(previewWidth);
    expect(await active.evaluate(image=>(image.parentElement as HTMLElement).style.transform)).toBe(transform);
    await page.keyboard.press('Escape');
    await expect(page.locator('.pswp')).toHaveCount(0);
    await expect.poll(()=>photo('weekend-0.jpg').locator('img').evaluate((image:HTMLImageElement)=>image.naturalWidth)).toBeGreaterThan(0);
  } finally { releasePreview();releaseFull();await page.unrouteAll({behavior:'wait'}); }
});

test('failed preview and full-size upgrades keep the cached thumbnail visible',async ({page})=>{
  const auth=await import('../src/lib/server/auth');
  const invitation=auth.createMember('Viewer fallback','viewer-fallback');
  await page.setViewportSize({width:390,height:844});
  await page.goto(`${origin}${basePath}/#invite=${invitation.token}`);
  const photo=page.locator('.photo-open').filter({has:page.locator('img[alt="weekend-0.jpg"]')});
  await photo.scrollIntoViewIfNeeded();
  await expect.poll(()=>photo.locator('img').evaluate((image:HTMLImageElement)=>image.naturalWidth)).toBeGreaterThan(0);
  const source=await photo.locator('img').getAttribute('src');
  let failures=0, fullFailed=false;
  await page.route('**/api/media/**',route=>{
    if(['preview','fullsize'].includes(new URL(route.request().url()).searchParams.get('kind')||'')){
      failures++; if(new URL(route.request().url()).searchParams.get('kind')==='fullsize')fullFailed=true;
      return route.fulfill({status:503,body:'Unavailable'});
    }
    return route.continue();
  });
  await photo.click();
  const active=page.locator('.pswp__item[aria-hidden="false"] img.pswp__img:not(.pswp__img--placeholder)');
  await expect(active).toHaveAttribute('src',source!);
  await page.getByRole('button',{name:'Zoom',exact:true}).click();
  await expect.poll(()=>fullFailed).toBe(true);
  expect(failures).toBeGreaterThan(1);
  await expect(active).toHaveAttribute('data-resolution','thumbnail');
  await expect.poll(()=>active.evaluate((image:HTMLImageElement)=>image.naturalWidth)).toBeGreaterThan(0);
  await expect(page.locator('.pswp__error-msg')).toHaveCount(0);
});


test('identical queued files transfer once and duplicate checks reject invalid or unauthenticated requests', async ({ page, request }) => {
  const auth = await import('../src/lib/server/auth');
  const invitation = auth.createMember('Hash queue', 'hash-queue');
  const endpoint = `${origin}${basePath}/api/upload/check`;
  expect((await request.post(endpoint, { headers: { origin }, data: { checksum: 'a'.repeat(64), size: 10 } })).status()).toBe(401);
  await page.goto(`${origin}${basePath}/#invite=${invitation.token}`);
  await expect(page.locator('.photo-tile').first()).toBeVisible();
  for (const input of [null, {}, { checksum: '../file', size: 1 }, { checksum: 'a'.repeat(64), size: -1 }, { checksum: 'a'.repeat(64), size: 1e15 }]) {
    expect((await page.request.post(endpoint, { headers: { origin }, data: JSON.stringify(input) })).status()).toBe(400);
  }
  expect((await page.request.post(endpoint, { headers: { origin }, data: 'x'.repeat(1025) })).status()).toBe(413);
  const payload = await sharp({ create: { width: 31, height: 29, channels: 3, background: '#123789' } }).png().toBuffer();
  let transfers = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === `${basePath}/api/upload`) transfers++; });
  await page.locator('input[type="file"]').setInputFiles([
    { name: 'first.png', mimeType: 'image/png', buffer: payload },
    { name: 'same-but-renamed.png', mimeType: 'image/png', buffer: payload }
  ]);
  await expect(page.locator('.upload-panel')).toContainText('2 of 2 finished · 1 skipped');
  expect(transfers).toBe(1);
  expect((await readdir(path.join(directory, 'photos', 'hash-queue'))).filter(name => !name.startsWith('.'))).toHaveLength(1);
});

test('duplicate checks retry before sending any file and can be cancelled', async ({ page }) => {
  const auth = await import('../src/lib/server/auth');
  const invitation = auth.createMember('Hash retry', 'hash-retry');
  await page.goto(`${origin}${basePath}/#invite=${invitation.token}`);
  await expect(page.locator('.photo-tile').first()).toBeVisible();
  let checks = 0, transfers = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === `${basePath}/api/upload`) transfers++; });
  await page.route('**/api/upload/check', async route => {
    checks++;
    if (checks === 1) await route.abort();
    else await route.continue();
  });
  const payload = await readFile(path.join(directory, 'photos', 'host', 'weekend-0.jpg'));
  await page.locator('input[type="file"]').setInputFiles({ name: 'hash-retry.jpg', mimeType: 'image/jpeg', buffer: payload });
  await expect(page.locator('.upload-panel')).toContainText('Duplicate check interrupted. Retrying automatically');
  await expect(page.locator('.upload-panel')).toContainText('Already in collection · skipped');
  expect(checks).toBe(2);
  expect(transfers).toBe(0);
  await page.unroute('**/api/upload/check');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/upload/check', async route => { await gate; await route.fulfill({ json: { duplicate: false } }).catch(() => {}); });
  try {
    await page.locator('input[type="file"]').setInputFiles({ name: 'cancel-check.jpg', mimeType: 'image/jpeg', buffer: payload });
    await expect(page.locator('.upload-panel')).toContainText('Checking for duplicates');
    await page.getByRole('button', { name: 'Cancel cancel-check.jpg', exact: true }).click();
    await expect(page.locator('.upload-panel')).toContainText('Cancelled');
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
  expect(transfers).toBe(0);
});


test('search defaults to semantic relevance, combines people and conditions, and keeps filename search available', async ({ page, request }) => {
  const auth = await import('../src/lib/server/auth');
  const invitation = auth.createMember('Semantic search', 'semantic-search');
  const smartRequests: Record<string, any>[] = [];
  // Observe the private Gather request; upstream credentials never reach the browser.
  page.on('request', request => {
    if (request.url().includes('/api/photos?') && new URL(request.url()).searchParams.get('q')) {
      const params = new URL(request.url()).searchParams;
      smartRequests.push({ mode: JSON.parse(params.get('search') || '{}').mode, sort: params.get('sort') });
    }
  });
  expect((await request.get(`${origin}${basePath}/api/search/people`)).status()).toBe(401);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}${basePath}/#invite=${invitation.token}`);
  await expect(page.locator('.photo-tile').first()).toBeVisible();
  const initial = await (await page.request.get(`${origin}${basePath}/api/photos?limit=300`)).json();
  await expect(page.getByRole('button', { name: /^Filters(?:\s|$)/ })).toBeHidden();
  await page.getByLabel('Search photos', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'People', exact: true })).toBeVisible();
  const searchBox = await page.getByLabel('Search photos', { exact: true }).boundingBox();
  const toolsBox = await page.locator('.search-tools').boundingBox();
  expect(toolsBox!.y).toBeGreaterThanOrEqual(searchBox!.y + searchBox!.height);
  await page.getByRole('button', { name: 'People', exact: true }).click();
  await expect(page.getByLabel('Find a person', { exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: /^Filters(?:\s|$)/ })).toBeHidden();
  await expect(page.getByLabel('Search photos', { exact: true })).toBeFocused();
  await page.getByLabel('Search photos', { exact: true }).fill('friends on a road trip');
  await page.getByLabel('Search photos', { exact: true }).click();
  await expect.poll(() => smartRequests.length).toBeGreaterThan(0);
  await expect(page.locator('.timeline-date')).toHaveCount(0);
  expect(smartRequests.at(-1)).toEqual({ mode: 'semantic', sort: 'relevance' });
  const ranked = await (await page.request.get(`${origin}${basePath}/api/photos?q=friends+on+a+road+trip&sort=relevance&limit=300`)).json();
  await expect(page.locator('.photo-tile')).toHaveCount(ranked.photos.length);
  await expect.poll(() => page.locator('.photo-open img').evaluateAll(images => images.map(image => image.getAttribute('alt')))).toEqual(ranked.photos.map((photo: any) => photo.name));
  const refresh = page.waitForResponse(response => response.url().includes('/api/photos?'));
  await page.getByRole('button', { name: 'Refresh photos', exact: true }).click();
  await refresh;
  await expect(page.getByRole('button', { name: /^Filters(?:\s|$)/ })).toBeHidden();
  await page.getByLabel('Search photos', { exact: true }).click();
  await page.getByRole('button', { name: /^Filters(?:\s|$)/ }).click();
  await page.getByRole('button', { name: 'Alice face (1 photos)', exact: true }).click();
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect(page.locator('.photo-tile')).toHaveCount(1);
  await expect(page.locator('.photo-open img')).toHaveAttribute('alt', 'weekend-0.jpg');
  await page.getByRole('button', { name: /^Filters(?:\s|$)/ }).click();
  await page.getByLabel('People match', { exact: true }).selectOption('none');
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect(page.locator('.photo-tile')).toHaveCount(ranked.photos.length - 1);
  await page.getByRole('button', { name: /^Filters(?:\s|$)/ }).click();
  await page.getByRole('button', { name: 'Clear people', exact: true }).click();
  await page.getByRole('button', { name: '+ Add condition', exact: true }).click();
  await page.getByLabel('Filter field', { exact: true }).selectOption('city');
  await page.getByLabel('Filter value', { exact: true }).fill('Paris');
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect(page.locator('.photo-tile')).toHaveCount(1);
  await page.getByRole('button', { name: /^Filters(?:\s|$)/ }).click();
  await page.getByRole('button', { name: 'Remove condition', exact: true }).click();
  await page.getByLabel('Search mode', { exact: true }).selectOption('filename');
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await page.getByLabel('Search photos', { exact: true }).fill('WEEKEND-0');
  await expect(page.locator('.photo-tile')).toHaveCount(1);
  await expect(page.locator('.photo-open img')).toHaveAttribute('alt', 'weekend-0.jpg');
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await page.getByRole('button', { name: /^Filters(?:\s|$)/ }).click();
  await page.getByRole('button', { name: '+ Add condition', exact: true }).click();
  await page.getByLabel('Filter field', { exact: true }).selectOption('personIds');
  await page.getByLabel('Filter value', { exact: true }).fill(Array(190).fill('11111111-1111-4111-8111-111111111111').join(','));
  const largeSearch = page.waitForResponse(response => new URL(response.url()).pathname === `${basePath}/api/photos` && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  expect((await largeSearch).status()).toBe(200);
  await expect(page.locator('.photo-tile')).toHaveCount(1);
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await page.getByLabel('Search photos', { exact: true }).fill('no-such-photo');
  await expect(page.getByRole('heading', { name: 'No matching photos' })).toBeVisible();
});


test('Back closes previews and every modal, and ordinary closes preserve page navigation', async ({ page }) => {
  const auth = await import('../src/lib/server/auth');
  const invite = auth.createMember('Modal navigation', 'modal-navigation');
  const session = auth.exchangeInvite(invite.token)!;
  await page.context().addCookies([{ name: 'gather_session', value: session.sessionToken, url: `${origin}${basePath || '/'}` }]);
  const previous = `${origin}${basePath}/api/health`;
  await page.goto(previous);
  await page.goto(`${origin}${basePath}/`);
  await expect(page.locator('.photo-open').first()).toBeVisible();
  const gallery = page.url();
  const profile = page.locator('.profile-dialog');
  const pending = page.locator('.pending-dialog');
  const settled = () => expect.poll(() => page.evaluate(() => !(window.history.state?.['sveltekit:states']?.modalIds?.length))).toBe(true);
  await page.getByRole('button', { name: 'Open weekend-0.jpg, shared by Host', exact: true }).click();
  await expect(page.locator('.pswp')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await page.goBack();
  await expect(page.locator('.pswp')).toHaveCount(0);
  expect(page.url()).toBe(gallery);
  await page.getByRole('button', { name: 'Change name for Modal navigation' }).first().click();
  await expect(profile).toBeVisible();
  await page.getByLabel('Display name', { exact: true }).fill('Unsaved name');
  await page.goBack();
  await expect(profile).not.toBeVisible();
  expect(page.url()).toBe(gallery);
  // Force the unavailable-preview path without changing any actual photo.
  let unavailable = '';
  await page.route('**/api/photos?*', async route => {
    const response = await route.fetch();
    const body = await response.json();
    unavailable = body.photos[0].name;
    body.photos[0].previewStatus = 'unavailable';
    await route.fulfill({ response, json: body });
  });
  await page.getByRole('button', { name: 'Refresh photos', exact: true }).click();
  await expect.poll(() => unavailable).not.toBe('');
  await page.getByRole('button', { name: `Open ${unavailable},`, exact: false }).click();
  await expect(pending).toBeVisible();
  await page.goBack();
  await expect(pending).not.toBeVisible();
  expect(page.url()).toBe(gallery);
  // Nested dialogs consume one Back each, leaving the lower dialog open.
  await page.getByRole('button', { name: 'Change name for Modal navigation' }).first().click();
  await page.evaluate(() => (document.querySelector('.pending-dialog') as HTMLDialogElement).showModal());
  await expect(pending).toBeVisible();
  await page.goBack();
  await expect(pending).not.toBeVisible();
  await expect(profile).toBeVisible();
  await page.goBack();
  await expect(profile).not.toBeVisible();
  // Closing explicitly consumes the entry too; repeat and rapidly reopen.
  await page.getByRole('button', { name: 'Change name for Modal navigation' }).first().click();
  await page.getByRole('button', { name: 'Close name settings', exact: true }).click();
  await page.getByRole('button', { name: 'Change name for Modal navigation' }).first().click();
  await expect(profile).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(profile).not.toBeVisible();
  await settled();
  await page.goBack();
  await expect(page).toHaveURL(previous);
});

test('one admin creates and switches collections while guest access, files, and invitations stay isolated', async ({ page, browser, request }) => {
  const adminEndpoint = `${origin}${basePath}/api/admin`;
  const session = await (await page.request.get(`${adminEndpoint}/session`)).json();
  const login = await page.request.post(`${adminEndpoint}/session`, { headers: { origin }, data: {
    action: session.configured ? 'login' : 'setup', password: 'a-private-admin-password',
    ...(!session.configured ? { token: (await readFile(path.join(directory, 'data', 'admin-setup-token'), 'utf8')).trim() } : {})
  } });
  expect(login.status()).toBe(200);
  const initial = await (await page.request.get(`${adminEndpoint}/config`)).json();
  const saved = await page.request.post(`${adminEndpoint}/config`, { headers: { origin }, data: { action: 'save', confirmFolderChange: true, settings: {
    ...initial.settings, collectionName: 'First collection', photoRoot: path.join(directory, 'photos', 'host'), immichPhotoRoot: '/external/gather/host', immichApiKey: '', immichScanApiKey: ''
  } } });
  expect(saved.status()).toBe(200);
  const firstInvite = await (await page.request.post(`${adminEndpoint}/config`, { headers: { origin }, data: { action: 'create-member', name: 'First guest', folder: 'Owner' } })).json();
  const guest = await browser.newContext();
  const firstPage = await guest.newPage();
  try {
    // The full suite already consumes the default collection's sign-in budget.
    // Seed this existing visitor; the new collection still signs in through its invitation UI.
    const auth = await import('../src/lib/server/auth');
    const firstToken = new URLSearchParams(new URL(firstInvite.link).hash.slice(1)).get('invite')!;
    const firstSession = auth.exchangeInvite(firstToken)!;
    await guest.addCookies([{ name: 'gather_session', value: firstSession.sessionToken, domain: new URL(origin).hostname, path: basePath || '/', httpOnly: true, sameSite: 'Lax' }]);
    await firstPage.goto(`${origin}${basePath}/`);
    await expect(firstPage.locator('.photo-tile')).toHaveCount(2);
    await page.goto(`${origin}${basePath}/admin`);
    await page.getByRole('button', { name: '+ New collection', exact: true }).click();
    await page.getByLabel('New collection name', { exact: true }).fill('Second collection');
    await page.getByRole('button', { name: 'Browse folders', exact: true }).click();
    await page.getByRole('button', { name: '▱ bob →', exact: true }).click();
    await page.getByRole('button', { name: 'Use this folder', exact: true }).click();
    await page.getByRole('button', { name: 'Create collection', exact: true }).click();
    await page.waitForURL(new RegExp(`${basePath}/c/[a-z0-9-]+/admin$`));
    const collectionBase = new URL(page.url()).pathname.replace(/\/admin$/, '');
    const secondApi = `${origin}${collectionBase}/api`;
    await expect(page.getByLabel('Manage collection')).toHaveValue(collectionBase.split('/').at(-1)!);
    const overview = await (await page.request.get(`${secondApi}/admin/config`)).json();
    expect(overview.collections).toHaveLength(2);
    expect(overview.settings.photoRoot).toBe(path.join(directory, 'photos', 'bob'));
    expect(overview.settings.immichPhotoRoot).toBe('/external/gather/bob');
    expect(overview.previewKeyConfigured).toBe(true);
    expect(overview.settings.immichApiKey).toBeUndefined();
    expect(overview.members).toEqual([]);
    expect((await firstPage.request.get(`${secondApi}/photos`)).status()).toBe(401);
    const oldToken = new URLSearchParams(new URL(firstInvite.link).hash.slice(1)).get('invite');
    expect((await firstPage.request.post(`${secondApi}/session`, { headers: { origin }, data: { token: oldToken } })).status()).toBe(401);
    await page.getByRole('button', { name: 'People & invitations', exact: true }).click();
    await page.getByLabel('Display name', { exact: true }).fill('Second guest');
    await page.getByLabel('Upload folder', { exact: true }).fill('Owner');
    await page.getByRole('button', { name: 'Create personal invitation', exact: true }).click();
    const secondInvite = await page.getByRole('textbox', { name: 'Generated invitation link' }).inputValue();
    expect(new URL(secondInvite).pathname).toBe(`${collectionBase}/`);
    const secondPage = await guest.newPage();
    await secondPage.goto(secondInvite);
    await expect(secondPage.locator('.photo-tile')).toHaveCount(1);
    const both = await Promise.all([firstPage.request.get(`${origin}${basePath}/api/photos`), secondPage.request.get(`${secondApi}/photos`)]);
    const [one, two] = await Promise.all(both.map(response => response.json()));
    expect(one.photos.map((photo: any) => photo.name).sort()).toEqual(['weekend-0.jpg', 'weekend-1.jpg']);
    expect(two.photos.map((photo: any) => photo.name)).toEqual(['weekend-2.jpg']);
    expect((await firstPage.request.get(`${origin}${basePath}/api/media/${two.photos[0].id}?kind=original`)).status()).toBe(404);
    expect((await secondPage.request.get(`${secondApi}/media/${one.photos[0].id}?kind=original`)).status()).toBe(404);
    const image = await sharp({ create: { width: 19, height: 21, channels: 3, background: '#a12390' } }).png().toBuffer();
    await secondPage.locator('input[type="file"]').setInputFiles({ name: 'only-second.png', mimeType: 'image/png', buffer: image });
    await expect(secondPage.locator('.upload-panel')).toContainText('Saved · Immich preview processing');
    expect(await readFile(path.join(directory, 'photos', 'bob', 'Owner', 'only-second.png'))).toEqual(image);
    expect((await (await firstPage.request.get(`${origin}${basePath}/api/photos`)).json()).total).toBe(2);
    const firstMembers = await (await page.request.get(`${adminEndpoint}/config`)).json();
    expect(firstMembers.members.map((member: any) => member.name)).toEqual(['First guest']);
    await page.getByLabel('Manage collection').selectOption('default');
    await page.waitForURL(`${origin}${basePath}/admin`);
    await expect(page.getByLabel('Collection name', { exact: true })).toHaveValue('First collection');
    await secondPage.request.post(`${secondApi}/logout`, { headers: { origin }, data: {} });
    expect((await secondPage.request.get(`${secondApi}/photos`)).status()).toBe(401);
    expect((await firstPage.request.get(`${origin}${basePath}/api/photos`)).status()).toBe(200);
    const cookies = await guest.cookies();
    expect(cookies.some(cookie => cookie.name === 'gather_session')).toBe(true);
    expect(cookies.some(cookie => cookie.name.startsWith('gather_session_'))).toBe(false);
    expect((await request.get(`${secondApi}/admin/config`)).status()).toBe(401);
  } finally { await guest.close(); }
});
