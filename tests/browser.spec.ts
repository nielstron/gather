import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

let directory: string, origin: string, token: string, server: Server, app: ChildProcess;
let scans = 0;
let appLog = '';
const indexed = new Map<string, string>();
const images = new Map<string, Buffer>();
const dimensions = new Map<string, { width: number; height: number }>();
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
      if (request.url === `/api/libraries/${libraryId}/scan` && request.method === 'POST') {
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
      if (id && images.has(id)) { response.writeHead(200, { 'content-type': 'image/jpeg' }).end(images.get(id)); return; }
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
    try { return (await fetch(`${origin}/api/health`)).status; } catch { return 0; }
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
  expect((await request.get(`${origin}/api/photos`)).status()).toBe(401);
  const csrf = await request.post(`${origin}/api/join`, { data: { token, name: 'Alice' }, headers: { origin: 'https://attacker.invalid' } });
  expect(csrf.status()).toBe(403);
  await page.goto(`${origin}/#share=${token}`);
  await page.getByLabel('Your name', { exact: true }).fill('Alice');
  await page.getByRole('button', { name: 'Join collection', exact: true }).click();
  await expect(page.getByRole('button', { name: 'All photos', exact: false }).first()).toBeVisible();
  await expect(page.locator('img[src*="/api/media/"]')).toHaveCount(3);
  await expect.poll(() => page.locator('img[src*="/api/media/"]').evaluateAll((images) => images.every((image) => (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
  await expect(page.locator('.timeline-group')).toHaveCount(2);
  await page.getByLabel('Sort photos').selectOption('name');
  await expect(page.locator('.timeline-group')).toHaveCount(1);
  await expect(page.locator('.timeline-date')).toHaveCount(0);
  await page.getByLabel('Sort photos').selectOption('newest');
  await expect(page.locator('.timeline-group')).toHaveCount(2);
  const selection = page.getByRole('checkbox', { name: 'Select weekend-0.jpg', exact: true });
  await selection.check();
  await expect(page.locator('.selection-bar')).toContainText('1 selected');
  await expect(page.getByRole('button', { name: 'Download originals', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await expect(selection).not.toBeChecked();
  await expect(page.locator('.selection-bar')).toHaveCount(0);
  expect(page.url()).not.toContain(token);
  const response = await page.request.get(`${origin}/api/photos`);
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
  await expect.poll(async () => (await (await page.request.get(`${origin}/api/photos`)).json()).total).toBe(4);
  const updated = await (await page.request.get(`${origin}/api/photos`)).json();
  const uploaded = updated.photos.find((photo: { name: string }) => photo.name === 'new-memory.png');
  expect(uploaded.folder).toBe(aliceFolder);
  const download = await page.request.get(`${origin}/api/media/${uploaded.id}?kind=original`);
  expect((await download.body()).equals(payload)).toBe(true);
  const zip = await page.request.post(`${origin}/api/download`, { headers: { origin }, data: { ids: updated.photos.map((photo: { id: string }) => photo.id) } });
  expect(zip.status()).toBe(200);
  expect(zip.headers()['content-type']).toBe('application/zip');
  const zipBody = await zip.body();
  expect(zipBody.subarray(0, 2).toString()).toBe('PK');
  expect(zipBody.includes(Buffer.from(`${aliceFolder}/new-memory.png`))).toBe(true);
  const traversal = Buffer.from('../secret.jpg').toString('base64url');
  expect((await page.request.get(`${origin}/api/media/${traversal}?kind=original`)).status()).toBe(400);

  const bob = await browser.newContext();
  const login = await bob.request.post(`${origin}/api/join`, { headers: { origin }, data: { token, name: 'Bob' } });
  expect(login.status()).toBe(200);
  const bobFolder = (await login.json()).user.folder;
  expect(bobFolder).not.toBe('bob');
  const bobUpload = await bob.request.post(`${origin}/api/upload?folder=alice`, { headers: { origin, 'x-filename': 'bobs-photo.png', 'content-type': 'application/octet-stream' }, data: payload });
  expect(bobUpload.status()).toBe(201);
  expect((await bobUpload.json()).photo.folder).toBe(bobFolder);
  expect((await bob.request.get(`${origin}/api/media/${uploaded.id}?kind=original`)).status()).toBe(200);
  await bob.close();

  await page.getByRole('button', { name: 'Close uploads', exact: true }).click();
  await page.getByRole('button', { name: 'Change name for Alice', exact: true }).click();
  await page.getByRole('dialog').getByRole('textbox').fill('Alicia');
  await page.getByRole('button', { name: 'Save name', exact: true }).click();
  await expect.poll(async () => {
    const data = await (await page.request.get(`${origin}/api/photos`)).json();
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
