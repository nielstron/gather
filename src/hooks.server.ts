import { withSettings, sessionCookieName, readSettings } from '$lib/server/settings';
import { getAdminSession } from '$lib/server/admin';
import { json, type Handle } from '@sveltejs/kit';
import { ensureCanonicalFolders } from '$lib/server/contributor-folders';
import { getSession } from '$lib/server/auth';
import { collectionIdFromPath } from '$lib/collection-path';
import { config } from '$lib/server/config';

const publicApis = new Set(['/api/session', '/api/join', '/api/health', '/api/admin/session']);
const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);

export const handle: Handle = ({ event, resolve }) => withSettings(async () => {
  await ensureCanonicalFolders();
  event.locals.user = getSession(event.cookies.get(sessionCookieName()));
  const pathname = event.route?.id ?? event.url.pathname.slice(config.basePath.length);
  const isApi = pathname === '/api' || pathname.startsWith('/api/');
  let response: Response;

  const requestOrigin = event.request.headers.get('origin');
  const configuredOrigin = new URL(config.origin).origin;
  const validOrigin = requestOrigin === configuredOrigin ||
    (process.env.NODE_ENV !== 'production' && requestOrigin === event.url.origin);

  if (!safeMethods.has(event.request.method) && !validOrigin) {
    response = json({ error: 'This request must come from the configured Gather site.' }, { status: 403 });
  } else if (pathname.startsWith('/api/admin/') && !publicApis.has(pathname) && !getAdminSession(event.cookies.get('gather_admin'))) {
    response = json({ error: 'Sign in as the administrator.' }, { status: 401 });
  } else if (isApi && !pathname.startsWith('/api/admin/') && !publicApis.has(pathname) && !event.locals.user) {
    response = json({ error: 'Open your invitation link to sign in.' }, { status: 401 });
  } else if (readSettings().readOnly && (pathname === '/api/upload' || pathname.startsWith('/api/upload/') || pathname === '/api/import' || pathname === '/api/immich/scan')) {
    response = json({ error: 'This collection is read-only. You can browse and download photos.' }, { status: 403 });
  } else {
    response = await resolve(event);
  }

  response.headers.set('referrer-policy', 'no-referrer');
  response.headers.set('x-content-type-options', 'nosniff');
  response.headers.set('x-frame-options', 'DENY');
  // HTML can contain private member details, so it must not enter a shared cache.
  const privatePreview = pathname.startsWith('/api/media/') && response.ok &&
    response.headers.get('content-type')?.startsWith('image/') &&
    response.headers.get('cache-control')?.startsWith('private, max-age=');
  if ((isApi && !privatePreview) || response.headers.get('content-type')?.includes('text/html')) {
    response.headers.set('cache-control', 'private, no-store');
  }
  return response;
}, collectionIdFromPath(event.url.pathname, config.basePath));
