import { json, type RequestHandler } from '@sveltejs/kit';
import { openPhoto } from '$lib/server/media';
import { photoInformation } from '$lib/server/immich';
import { apiError } from '$lib/server/http';

export const GET: RequestHandler = async ({ params, request }) => {
  try {
    const file = await openPhoto(params.id!);
    await file.handle.close();
    try { return json(await photoInformation(file.relative, file.revision, request.signal)); }
    catch (error) {
      if ((error as { status?: number }).status === 404) return apiError(error);
      return json({ state: 'unavailable' });
    }
  } catch (error) { return apiError(error); }
};
