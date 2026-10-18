import { collectionPath } from '$lib/collection-path';
import { currentCollectionId, sessionCookieName } from '$lib/server/settings';
import { config } from '$lib/server/config';
import { json, type RequestHandler } from '@sveltejs/kit';
import { deleteSession } from '$lib/server/auth';

export const POST: RequestHandler = ({ cookies }) => {
  deleteSession(cookies.get(sessionCookieName()));
  cookies.delete(sessionCookieName(), { path: collectionPath(config.basePath, currentCollectionId()) || '/' });
  return json({ ok: true });
};
