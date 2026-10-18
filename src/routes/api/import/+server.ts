import { json } from '@sveltejs/kit';
import { importer } from '$lib/server/importer';
import { apiError } from '$lib/server/http';
import { readAuthJson, allowAuthAttempt } from '$lib/server/auth-http';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals }) => {
  try {
    if (!locals.user) return json({ error: 'Sign in to import photos.' }, { status: 401 });
    return json({ jobs: importer.list(locals.user) });
  } catch (error) { return apiError(error); }
};

export const POST: RequestHandler = async ({ request, locals }) => {
  try {
    if (!locals.user) return json({ error: 'Sign in to import photos.' }, { status: 401 });
    const body = await readAuthJson(request);
    if (!body) return json({ error: 'Invalid import request.' }, { status: 400 });
    if (body.action === 'preview' && typeof body.url === 'string') {
      if (!allowAuthAttempt(locals.user.id, 'import-preview', 30)) return json({ error: 'Too many album previews. Try again shortly.' }, { status: 429 });
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(60_000)]);
      return json({ job: await importer.preview(locals.user, body.url, signal) });
    }
    if (typeof body.id !== 'string' || !/^[a-f0-9-]{36}$/.test(body.id)) return json({ error: 'Invalid import identifier.' }, { status: 400 });
    if (body.action === 'start' || body.action === 'retry') return json({ job: importer.start(locals.user, body.id) }, { status: 202 });
    if (body.action === 'cancel') return json({ job: importer.cancel(locals.user, body.id) });
    return json({ error: 'Unknown import action.' }, { status: 400 });
  } catch (error) { return apiError(error); }
};
