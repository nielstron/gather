import { json } from '@sveltejs/kit';
import { downloadInventory, selectedIds } from '$lib/server/download-options';
import { apiError, boundedText } from '$lib/server/http';
import type { RequestHandler } from './$types';
export const POST: RequestHandler = async ({ request, locals }) => {
  try {
    if (!locals.user) return json({ error: 'Sign in to download photos.' }, { status: 401 });
    let input; try { input = JSON.parse(await boundedText(request, 128_000)); } catch { return json({ error: 'Invalid download selection.' }, { status: 400 }); }
    const { contributors } = await downloadInventory(locals.user, selectedIds(input?.ids));
    return json({ contributors });
  } catch (error) { return apiError(error); }
};
