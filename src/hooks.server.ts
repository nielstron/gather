import { json, type Handle } from '@sveltejs/kit';
import { getSession } from '$lib/server/auth';
import { config } from '$lib/server/config';

const publicApis = new Set(['/api/session', '/api/join', '/api/health']);
const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);

export const handle: Handle = async ({ event, resolve }) => {
  event.locals.user = getSession(event.cookies.get('gather_session'));
  const isApi = event.url.pathname === '/api' || event.url.pathname.startsWith('/api/');
  let response: Response;

  const requestOrigin = event.request.headers.get('origin');
  const configuredOrigin = new URL(config.origin).origin;
  const validOrigin = requestOrigin === configuredOrigin ||
    (process.env.NODE_ENV !== 'production' && requestOrigin === event.url.origin);

  if (!safeMethods.has(event.request.method) && !validOrigin) {
    response = json({ error: 'This request must come from the configured Gather site.' }, { status: 403 });
  } else if (isApi && !publicApis.has(event.url.pathname) && !event.locals.user) {
    response = json({ error: 'Open your invitation link to sign in.' }, { status: 401 });
  } else {
    response = await resolve(event);
  }

  response.headers.set('referrer-policy', 'no-referrer');
  response.headers.set('x-content-type-options', 'nosniff');
  response.headers.set('x-frame-options', 'DENY');
  // HTML can contain private member details, so it must not enter a shared cache.
  if (isApi || response.headers.get('content-type')?.includes('text/html')) {
    response.headers.set('cache-control', 'private, no-store');
  }
  return response;
};
