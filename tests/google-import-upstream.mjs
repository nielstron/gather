// Test-process preload only. Production builds never load this fixture or relax
// their Google-only URL validation. All upstream bytes come from our mock server.
const originalFetch = globalThis.fetch;
const album = 'https://photos.google.com/share/AF1QGatherImportFixture12345?key=gatherImportShareKey12345';
const meta = []; meta[0] = 'AF1QGatherImportFixture12345'; meta[1] = 'Google Photos trip'; meta[21] = 2;
const rows = ['GatherImportPhotoOne', 'GatherImportPhotoTwo'].map(id => [id, [`https://lh3.googleusercontent.com/pw/${id}`, 52, 41], 1, null, 0, 1, null, null, null, {}]);
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.hostname === 'photos.app.goo.gl' && url.pathname === '/GatherImportFixture') return new Response(null, { status: 302, headers: { location: album } });
  if (url.hostname === 'photos.google.com' && url.pathname === '/share/AF1QGatherImportFixture12345') return new Response(`<script>AF_initDataCallback({key: 'ds:1', data:${JSON.stringify([null, rows, null, meta])}, sideChannel: {}});</script>`);
  if (url.hostname === 'lh3.googleusercontent.com' && /^\/pw\/GatherImportPhoto(?:One|Two)=d$/.test(url.pathname)) return originalFetch(`${process.env.IMPORT_TEST_UPSTREAM}/google-import-photo`, init);
  if (['photos.app.goo.gl', 'photos.google.com', 'lh3.googleusercontent.com'].includes(url.hostname)) return new Response('Missing test fixture', { status: 404 });
  return originalFetch(input, init);
};
