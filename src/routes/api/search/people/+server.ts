import { json } from '@sveltejs/kit';
import { scanPhotos } from '$lib/server/media';
import { listMembers } from '$lib/server/auth';
import { collectionPeople } from '$lib/server/immich';
import { apiError } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ request }) => {
  try { return json({ people: await collectionPeople(await scanPhotos(listMembers(), true), request.signal) }); }
  catch (error) { return apiError(error); }
};
