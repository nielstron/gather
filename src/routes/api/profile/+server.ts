import { json, type RequestHandler } from '@sveltejs/kit';
import { renameMember } from '$lib/server/auth';
import { allowAuthAttempt, readAuthJson } from '$lib/server/auth-http';
import { apiError } from '$lib/server/http';
import { invalidatePhotos } from '$lib/server/media';

export const PATCH: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) return json({ error: 'Open the shared link to join first.' }, { status: 401 });
  if (!allowAuthAttempt(locals.user.id, 'profile', 30)) return json({ error: 'Too many name changes. Please try again in 15 minutes.' }, { status: 429 });
  const body = await readAuthJson(request);
  if (typeof body?.name !== 'string') return json({ error: 'Enter your display name.' }, { status: 400 });
  try {
    const member = renameMember(locals.user.id, body.name);
    locals.user = member;
    invalidatePhotos();
    return json({ user: member });
  } catch (error) { return apiError(error); }
};
