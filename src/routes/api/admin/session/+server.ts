import { json } from '@sveltejs/kit';
import { adminConfigured, ensureSetupToken, getAdminSession, loginAdmin, logoutAdmin, setupAdmin } from '$lib/server/admin';
import { allowAuthAttempt, readAuthJson } from '$lib/server/auth-http';
import { config } from '$lib/server/config';
import { apiError } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ cookies }) => {
  ensureSetupToken();
  return json({ configured: adminConfigured(), authenticated: getAdminSession(cookies.get('gather_admin')) });
};

export const POST: RequestHandler = async ({ request, cookies, getClientAddress }) => {
  const body = await readAuthJson(request);
  if (body?.action === 'logout') {
    logoutAdmin(cookies.get('gather_admin'));
    cookies.delete('gather_admin', { path: config.basePath || '/' });
    return json({ ok: true });
  }
  if (!allowAuthAttempt(getClientAddress(), 'admin', 10)) return json({ error: 'Too many attempts. Try again in 15 minutes.' }, { status: 429 });
  if (typeof body?.password !== 'string') return json({ error: 'Enter your administrator password.' }, { status: 400 });
  try {
    const token = body.action === 'setup' && typeof body.token === 'string'
      ? setupAdmin(body.token, body.password) : loginAdmin(body.password);
    cookies.set('gather_admin', token, { path: config.basePath || '/', httpOnly: true, sameSite: 'strict', secure: config.secureCookies, maxAge: 12 * 3600 });
    return json({ ok: true });
  } catch (error) { return apiError(error); }
};
