import { config } from '$lib/server/config';
import { listMembers } from '$lib/server/auth';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => ({
  user: locals.user,
  members: locals.user ? listMembers() : [],
  collectionName: config.collectionName,
  maxUploadBytes: config.maxUploadBytes,
  immichConfigured: Boolean(process.env.IMMICH_URL && process.env.IMMICH_API_KEY && process.env.IMMICH_LIBRARY_ID && process.env.IMMICH_PHOTO_ROOT)
});
