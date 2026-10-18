import { sortPhotos } from '$lib/sort';
import { json } from '@sveltejs/kit';
import { listMembers } from '$lib/server/auth';
import { scanPhotos, invalidatePhotos, MediaError } from '$lib/server/media';
import { validateSearch } from '$lib/search';
import { enrichPhotos, searchCollection } from '$lib/server/immich';
import { apiError, boundedText } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, request }) => {
  try {
    if (url.searchParams.get('refresh') === '1') invalidatePhotos();
    const members = listMembers();
    let deadline: ReturnType<typeof setTimeout>;
    const all = await Promise.race([scanPhotos(members, true), new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(new MediaError(503, 'The photo storage is taking too long to respond. Please try again.')), 3000);
    })]).finally(() => clearTimeout(deadline));
    const folders = new Map(members.map((member) => [member.folder, { folder: member.folder, name: member.name, count: 0 }]));
    for (const photo of all) {
      if (!folders.has(photo.folder)) folders.set(photo.folder, { folder: photo.folder, name: photo.owner, count: 0 });
      folders.get(photo.folder)!.count++;
    }
    const folder = url.searchParams.get('folder');
    const query = (url.searchParams.get('q') || '').trim().slice(0, 1000);
    const raw = url.searchParams.get('search');
    if (raw && raw.length > 24_000) throw new MediaError(400, 'Too many search filters');
    let options;
    try { options = validateSearch(raw ? JSON.parse(raw) : { mode: 'semantic' }); }
    catch (error) { if ((error as { status?: number }).status === 400) throw error; throw new MediaError(400, 'Invalid search options'); }
    const subset = all.filter(photo => folder === null || photo.folder.toLowerCase() === folder.toLowerCase());
    const { photos: matching, truncated: searchTruncated } = await searchCollection(subset, query, options, request.signal);
    const relevance = url.searchParams.get('sort') === 'relevance' || (!url.searchParams.has('sort') && options.mode === 'semantic' && !!(query || options.queryAssetId));
    const ordered = relevance || options.orderBy ? (relevance && !options.orderBy && url.searchParams.get('direction') === 'asc' ? [...matching].reverse() : matching) : sortPhotos(matching, url.searchParams.get('sort') || 'date', url.searchParams.get('direction') || 'desc');
    const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') || '0', 10) || 0);
    const limit = Math.min(300, Math.max(1, Number.parseInt(url.searchParams.get('limit') || '150', 10) || 150));
    const { photos, previewService } = await enrichPhotos(ordered.slice(offset, offset + limit));
    return json({ photos, members, searchTruncated, previewService, folders: [...folders.values()], total: matching.length, offset, hasMore: offset + photos.length < matching.length });
  } catch (error) { return apiError(error); }
};


// Keep larger filter/ID lists out of proxy request-line limits. GET remains useful
// for small searches and callers; both transports share validation and scoping.
export const POST: RequestHandler = async (event) => {
  try {
    let input: unknown;
    try { input = JSON.parse(await boundedText(event.request, 32_768)); }
    catch (error) { if ((error as { status?: number }).status === 413) throw error; throw new MediaError(400, 'Invalid search request'); }
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new MediaError(400, 'Invalid search request');
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(input)) {
      if (!['q', 'search', 'sort', 'direction', 'folder', 'offset', 'limit', 'refresh'].includes(key) || typeof value !== 'string') throw new MediaError(400, 'Invalid search parameter');
      params.set(key, value);
    }
    const url = new URL(event.url);
    url.search = params.toString();
    return await GET({ ...event, url });
  } catch (error) { return apiError(error); }
};
