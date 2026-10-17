import { json, type RequestHandler } from '@sveltejs/kit';
import { exchangeInvite } from '$lib/server/auth';
import { allowAuthAttempt, readAuthJson, setSessionCookie } from '$lib/server/auth-http';

export const POST: RequestHandler = async ({ request, cookies, getClientAddress }) => {
  let address = 'unknown';
  try { address = getClientAddress(); } catch { /* Shared bucket when the adapter lacks an address. */ }
  if (!allowAuthAttempt(address)) {
    return json({ error: 'Too many sign-in attempts. Please try again in 15 minutes.' }, {
      status: 429, headers: { 'retry-after': '900' }
    });
  }
  const body = await readAuthJson(request);
  if (typeof body?.token !== 'string' || !body.token) return json({ error: 'Enter a valid invitation token.' }, { status: 400 });
  const result = exchangeInvite(body.token);
  if (!result) return json({ error: 'This invitation is invalid or has been revoked. Ask your host for a new one.' }, { status: 401 });
  setSessionCookie(cookies, result.sessionToken);
  return json({ user: result.member });
};
