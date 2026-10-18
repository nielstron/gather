import { readSettings } from '$lib/server/settings';
import { config } from '$lib/server/config';
import { listMembers, uploadScope } from '$lib/server/auth';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => ({
  user: locals.user,
  readOnly: readSettings().readOnly === true,
  uploadOwnerScope: locals.user ? uploadScope(locals.user, 'browser-queue') : '',
  members: locals.user ? listMembers() : [],
  collectionName: config.collectionName,
  maxUploadBytes: config.maxUploadBytes,
  immichConfigured: Boolean(readSettings().immichUrl && readSettings().immichApiKey && readSettings().immichLibraryId && readSettings().immichPhotoRoot)
});
