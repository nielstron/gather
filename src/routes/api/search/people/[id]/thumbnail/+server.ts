import type { RequestHandler } from '@sveltejs/kit';
import { listMembers } from '$lib/server/auth';
import { scanPhotos } from '$lib/server/media';
import { personThumbnail } from '$lib/server/immich';
import { apiError } from '$lib/server/http';
export const GET: RequestHandler = async ({ params, request }) => {
  try { return await personThumbnail(params.id!, await scanPhotos(listMembers(), true), request.signal); }
  catch (error) { return apiError(error); }
};
