import { json, type RequestHandler } from '@sveltejs/kit';
import { deleteSession } from '$lib/server/auth';

export const POST: RequestHandler = ({ cookies }) => {
  deleteSession(cookies.get('gather_session'));
  cookies.delete('gather_session', { path: '/' });
  return json({ ok: true });
};
