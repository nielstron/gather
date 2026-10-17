import { json, type RequestHandler } from '@sveltejs/kit';
import { joinCollection } from '$lib/server/auth';
import { allowAuthAttempt, readAuthJson, setSessionCookie } from '$lib/server/auth-http';
import { apiError } from '$lib/server/http';
import { invalidatePhotos } from '$lib/server/media';

export const POST: RequestHandler = async ({ request, cookies, getClientAddress }) => {
  let address = 'unknown';
  try { address = getClientAddress(); } catch { /* Use one bounded bucket when unavailable. */ }
  if (!allowAuthAttempt(address, 'join', 30)) return json({ error: 'Too many join attempts. Please try again in 15 minutes.' }, {
    status: 429, headers: { 'retry-after': '900' }
  });
  const body = await readAuthJson(request);
  if (typeof body?.token !== 'string' || typeof body?.name !== 'string') {
    return json({ error: 'Open the shared link and enter your name.' }, { status: 400 });
  }
  try {
    const result = joinCollection(body.token, body.name);
    setSessionCookie(cookies, result.sessionToken);
    invalidatePhotos();
    return json({ user: result.member });
  } catch (error) { return apiError(error); }
};
