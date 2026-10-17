const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');
const load = createRequire('/usr/src/app/server/package.json');
load('reflect-metadata');
load('./dist/cores/storage.core').StorageCore.setMediaLocation('/data');
const { LibraryService } = load('./dist/services/library.service');
const { LibraryRepository } = load('./dist/repositories/library.repository');
const { ScanLibraryPathDto } = load('./dist/dtos/library.dto');
const { JobName, JobStatus } = load('./dist/enum');
const { Kysely, PostgresDialect } = load('kysely');

let temporary;
after(async () => { if (temporary) await fs.rm(temporary, { recursive: true, force: true }); });

async function fixture() {
  temporary ||= await fs.mkdtemp('/tmp/immich-scan-path-');
  const root = path.join(temporary, 'library');
  const folder = path.join(root, 'COLM trip');
  await fs.mkdir(folder, { recursive: true });
  await fs.mkdir(root + '-other', { recursive: true });
  await fs.symlink(root + '-other', path.join(root, 'escape')).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const library = { id: '11111111-1111-4111-8111-111111111111', importPaths: [root], exclusionPatterns: ['**/hidden/**'] };
  const queued = [], crawls = [], streamed = [];
  const sut = Object.create(LibraryService.prototype);
  sut.libraryRepository = {
    get: async () => library,
    update: async () => { throw new Error('A scoped scan must not update the whole-library scan timestamp'); },
    streamAssetIds: (id, directory) => {
      streamed.push([id, directory]);
      return (async function* () { yield { id: 'asset-within-selected-folder' }; })();
    },
  };
  sut.storageRepository = {
    stat: fs.stat, realpath: fs.realpath,
    checkFileExists: async (filename, mode) => { try { await fs.access(filename, mode); return true; } catch { return false; } },
    walk: options => {
      crawls.push(options);
      return (async function* () { yield [path.join(folder, 'new.jpg')]; })();
    },
  };
  sut.assetRepository = {
    filterNewExternalAssetPaths: async (_id, paths) => paths,
    getLibraryAssetCount: () => { throw new Error('Must not count the entire library'); },
    detectOfflineExternalAssets: () => { throw new Error('Must not run a library-wide offline update'); },
  };
  sut.jobRepository = { queue: async job => queued.push(job) };
  sut.logger = { log() {}, debug() {}, warn() {} };
  return { sut, library, root, folder, queued, crawls, streamed };
}

test('body validation requires one path and rejects unknown fields', () => {
  assert.deepEqual(ScanLibraryPathDto.schema.parse({ path: '/photos/trip' }), { path: '/photos/trip' });
  for (const body of [{}, { path: '' }, { path: null }, { path: [] }, { path: '/photos', importPaths: ['/'] }]) {
    assert.equal(ScanLibraryPathDto.schema.safeParse(body).success, false);
  }
});

test('scoped scans queue only the requested directory, and full scans remain unchanged', async () => {
  const { sut, library, folder, queued } = await fixture();
  await sut.queueScanPath(library.id, folder + '/');
  assert.deepEqual(queued, [
    { name: JobName.LibrarySyncFilesQueueAll, data: { id: library.id, path: folder } },
    { name: JobName.LibrarySyncAssetsQueueAll, data: { id: library.id, path: folder } },
  ]);
  queued.length = 0;
  await sut.queueScan(library.id);
  assert.deepEqual(queued, [
    { name: JobName.LibrarySyncFilesQueueAll, data: { id: library.id } },
    { name: JobName.LibrarySyncAssetsQueueAll, data: { id: library.id } },
  ]);
});

test('outside roots, sibling prefixes, traversal, files, and symlink escapes queue no jobs', async () => {
  const { sut, library, root, folder, queued } = await fixture();
  const file = path.join(folder, 'file.jpg');
  await fs.writeFile(file, 'test');
  for (const value of ['relative', '/etc', root + '-other', folder + '/../', root + '/escape', file, root + '/missing', folder + '\0']) {
    await assert.rejects(() => sut.queueScanPath(library.id, value));
  }
  assert.deepEqual(queued, []);
});

test('file discovery crawls the selected subtree with existing exclusions and no global timestamp update', async () => {
  const { sut, library, folder, crawls, queued } = await fixture();
  assert.equal(await sut.handleQueueSyncFiles({ id: library.id, path: folder }), JobStatus.Success);
  assert.equal(crawls.length, 1);
  assert.equal(crawls[0].followSymbolicLinks, false);
  assert.deepEqual(crawls[0].pathsToCrawl, [folder]);
  assert.deepEqual(crawls[0].exclusionPatterns, library.exclusionPatterns);
  assert.deepEqual(queued[0].data.paths, [path.join(folder, 'new.jpg')]);
});

test('existing-asset checks are scoped and never run the global offline sweep', async () => {
  const { sut, library, folder, queued, streamed } = await fixture();
  assert.equal(await sut.handleQueueSyncAssets({ id: library.id, path: folder }), JobStatus.Success);
  assert.deepEqual(streamed, [[library.id, folder]]);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].name, JobName.LibrarySyncAssets);
  assert.deepEqual(queued[0].data.assetIds, ['asset-within-selected-folder']);
  assert.deepEqual(queued[0].data.importPaths, library.importPaths);
});

test('workers revalidate the requested folder before touching the filesystem or database stream', async () => {
  const { sut, library, root, crawls, streamed } = await fixture();
  await assert.rejects(() => sut.handleQueueSyncFiles({ id: library.id, path: root + '/escape' }));
  await assert.rejects(() => sut.handleQueueSyncAssets({ id: library.id, path: root + '/escape' }));
  assert.deepEqual(crawls, []);
  assert.deepEqual(streamed, []);
});

test('database scope uses a directory boundary and escapes SQL LIKE wildcards', () => {
  const db = new Kysely({ dialect: new PostgresDialect({ pool: {} }) });
  const wrap = target => new Proxy(target, {
    get(object, key) {
      if (key === 'stream') return () => object.compile();
      const value = object[key];
      return typeof value === 'function' ? (...args) => wrap(value.apply(object, args)) : value;
    },
  });
  const repository = new LibraryRepository({ selectFrom: table => wrap(db.selectFrom(table)) });
  const compiled = repository.streamAssetIds('library-id', '/photos/COLM_%!');
  assert.match(compiled.sql, /"originalPath" LIKE \$2 ESCAPE '!'/);
  assert.deepEqual(compiled.parameters, ['library-id', '/photos/COLM!_!%!!/%']);
});


test('scoped discovery does not follow child symlinks into another directory', async () => {
  const { root, folder } = await fixture();
  const outside = root + '-other';
  await fs.writeFile(path.join(outside, 'outside.jpg'), 'outside');
  await fs.writeFile(path.join(folder, 'inside.jpg'), 'inside');
  await fs.symlink(outside, path.join(folder, 'linked')).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const { StorageRepository } = load('./dist/repositories/storage.repository');
  const storage = new StorageRepository({ setContext() {} });
  const found = [];
  for await (const batch of storage.walk({ pathsToCrawl: [folder], take: 100, followSymbolicLinks: false })) found.push(...batch);
  assert.ok(found.some(filename => filename.endsWith('/inside.jpg')));
  assert.ok(found.every(filename => !filename.endsWith('/outside.jpg')));
});
