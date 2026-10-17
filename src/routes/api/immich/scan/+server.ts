import { json } from '@sveltejs/kit';
import { requestLibraryScan } from '$lib/server/immich';
import { apiError } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async () => {
  try { return json(await requestLibraryScan()); }
  catch (error) { return apiError(error); }
};
