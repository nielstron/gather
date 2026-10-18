import { createLimiter } from '$lib/async';
import { json } from '@sveltejs/kit';
import { MediaError } from '$lib/server/media';
import { apiError, boundedText } from '$lib/server/http';
import { appendUpload, startUpload, finishUpload, cancelResumableUpload, chunkSize } from '$lib/server/resumable-upload';
import type { RequestHandler } from './$types';

const chunkSlots = createLimiter(4);

export const PUT: RequestHandler = async ({ request, params, locals }) => {
  try { return json(await startUpload(locals.user!, params.id, JSON.parse(await boundedText(request, 2048)))); }
  catch (error) { return error instanceof SyntaxError ? json({ error: 'Invalid upload details.' }, { status: 400 }) : apiError(error); }
};
export const PATCH: RequestHandler = async ({ request, params, locals }) => chunkSlots(async () => {
  try {
    const reader = request.body?.getReader();
    if (!reader) return json({ error: 'Missing upload chunk.' }, { status: 400 });
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.length;
        if (size > chunkSize) { await reader.cancel(); return json({ error: 'Upload chunk is too large.' }, { status: 413 }); }
        chunks.push(value);
      }
    } catch { throw new MediaError(408, 'Upload interrupted. Resume this photo.'); }
    finally { reader.releaseLock(); }
    const rawOffset = request.headers.get('upload-offset');
    if (!rawOffset || !/^\d+$/.test(rawOffset)) return json({ error: 'Invalid upload position.' }, { status: 400 });
    return json(await appendUpload(locals.user!, params.id, Number(rawOffset), Buffer.concat(chunks)));
  } catch (error) { return apiError(error); }
});
export const POST: RequestHandler = async ({ params, locals }) => {
  try { return json({ photo: await finishUpload(locals.user!, params.id) }); }
  catch (error) { return apiError(error); }
};
export const DELETE: RequestHandler = async ({ params, locals }) => {
  try { await cancelResumableUpload(locals.user!, params.id); return json({ cancelled: true }); }
  catch (error) { return apiError(error); }
};
