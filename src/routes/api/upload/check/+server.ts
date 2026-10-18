import { json } from '@sveltejs/kit';
import { config } from '$lib/server/config';
import { duplicatePhoto } from '$lib/server/media';
import { apiError, boundedText } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, locals }) => {
  try {
    if (!locals.user) return json({ error: 'Sign in to upload photos' }, { status: 401 });
    let input;
    try { input = JSON.parse(await boundedText(request, 1024)); }
    catch (error) {
      if ((error as { status?: number }).status === 413) throw error;
      return json({ error: 'Invalid duplicate check' }, { status: 400 });
    }
    if (!input || typeof input.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(input.checksum) ||
        !Number.isSafeInteger(input.size) || input.size <= 0 || input.size > config.maxUploadBytes) {
      return json({ error: 'Provide a SHA-256 checksum and a valid file size' }, { status: 400 });
    }
    const photo = await duplicatePhoto(input.checksum, input.size, AbortSignal.any([request.signal, AbortSignal.timeout(60_000)]));
    return json({ duplicate: !!photo, ...(photo ? { photo } : {}) });
  } catch (error) { return apiError(error); }
};
