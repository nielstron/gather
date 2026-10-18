import { json } from '@sveltejs/kit';
import { scanPhotos } from '$lib/server/media';
import { listMembers } from '$lib/server/auth';
import { collectionPeople } from '$lib/server/immich';
import { apiError } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ request, url }) => {
  try { return json({ people: await collectionPeople(await scanPhotos(listMembers(), true), request.signal, url.searchParams.get('faces') === '1') }); }
  catch (error) { return apiError(error); }
};
