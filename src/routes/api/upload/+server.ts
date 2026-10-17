import { json } from '@sveltejs/kit';
import { saveUpload } from '$lib/server/media';
import { requestLibraryScan } from '$lib/server/immich';
import { apiError } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, locals }) => {
  try {
    if (!locals.user) return json({ error: 'Sign in to upload photos' }, { status: 401 });
    let name: string;
    try { name = decodeURIComponent(request.headers.get('x-filename') || ''); }
    catch { return json({ error: 'Invalid filename' }, { status: 400 }); }
    const photo = await saveUpload(locals.user, name, request.body, request.signal);
    // The committed file triggers processing independently of the browser's lifetime.
    // Immich's cooldown combines uploads arriving close together into a trailing scan.
    void requestLibraryScan().then((result) => {
      if (result.state === 'unavailable') console.warn('Gather: automatic Immich scan unavailable; check the connection and scan API key.');
    }).catch(() => console.warn('Gather: automatic Immich scan failed.'));
    return json({ photo }, { status: 201 });
  } catch (error) { return apiError(error); }
};
