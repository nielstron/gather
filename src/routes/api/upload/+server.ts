import { json } from '@sveltejs/kit';
import { readUploadReceipt, writeUploadReceipt, uploadScope, AuthError } from '$lib/server/auth';
import type { Photo } from '$lib/types';
import { saveUpload } from '$lib/server/media';
import { requestLibraryScan } from '$lib/server/immich';
import { apiError } from '$lib/server/http';
import type { RequestHandler } from './$types';

const pending = new Map<string, { fingerprint: string; promise: Promise<Photo> }>();

export const POST: RequestHandler = async ({ request, locals }) => {
  try {
    if (!locals.user) return json({ error: 'Sign in to upload photos' }, { status: 401 });
    let name: string;
    try { name = decodeURIComponent(request.headers.get('x-filename') || ''); }
    catch { return json({ error: 'Invalid filename' }, { status: 400 }); }
    const key = request.headers.get('x-upload-id');
    if (key && !/^[A-Za-z0-9_-]{16,100}$/.test(key)) throw new AuthError(400, 'Invalid upload identifier.');
    const fingerprint = JSON.stringify([name, request.headers.get('content-type'), request.headers.get('x-upload-size')]);
    const scope = key ? uploadScope(locals.user, key) : undefined;
    const cached = scope ? readUploadReceipt(scope, fingerprint) : null;
    const running = scope ? pending.get(scope) : undefined;
    if (running && running.fingerprint !== fingerprint) throw new AuthError(409, 'This upload identifier is being used for another file.');
    if (cached || running) {
      // Drain without buffering: cancelling an incoming body closes its HTTP socket.
      await request.body?.pipeTo(new WritableStream());
      return json({ photo: cached || await running!.promise }, { status: 200 });
    }
    const work = (async () => {
      const photo = await saveUpload(locals.user!, name, request.body, request.signal);
      if (scope) writeUploadReceipt(scope, fingerprint, photo);
      // Processing continues even when the browser loses the response.
      void requestLibraryScan().then((result) => {
        if (result.state === 'unavailable') console.warn('Gather: automatic Immich scan unavailable; check the connection and scan API key.');
      }).catch(() => console.warn('Gather: automatic Immich scan failed.'));
      return photo;
    })();
    if (scope) pending.set(scope, { fingerprint, promise: work });
    try { return json({ photo: await work }, { status: 201 }); }
    finally { if (scope && pending.get(scope)?.promise === work) pending.delete(scope); }
  } catch (error) { return apiError(error); }
};
