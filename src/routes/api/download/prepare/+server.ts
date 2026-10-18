import { json } from '@sveltejs/kit';
import { createDownloadTicket } from '$lib/server/auth';
import { chooseDownload } from '$lib/server/download-options';
import { apiError, boundedText } from '$lib/server/http';
import { MediaError } from '$lib/server/media';
import type { RequestHandler } from './$types';
export const POST: RequestHandler = async ({ request, locals }) => {
  try {
    if (!locals.user) throw new MediaError(401, 'Sign in to download photos.');
    let choice: unknown;
    try { choice = JSON.parse(await boundedText(request, 128_000)); }
    catch { throw new MediaError(400, 'Invalid download options.'); }
    await chooseDownload(locals.user, choice);
    return json({ ticket: createDownloadTicket(locals.user, choice) });
  } catch (error) { return apiError(error); }
};
