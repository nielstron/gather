import { sortPhotos } from '$lib/sort';
import { json } from '@sveltejs/kit';
import { listMembers } from '$lib/server/auth';
import { scanPhotos, invalidatePhotos } from '$lib/server/media';
import { enrichPhotos } from '$lib/server/immich';
import { apiError } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
  try {
    if (url.searchParams.get('refresh') === '1') invalidatePhotos();
    const members = listMembers();
    const all = await scanPhotos(members);
    const folders = new Map(members.map((member) => [member.folder, { folder: member.folder, name: member.name, count: 0 }]));
    for (const photo of all) {
      if (!folders.has(photo.folder)) folders.set(photo.folder, { folder: photo.folder, name: photo.owner, count: 0 });
      folders.get(photo.folder)!.count++;
    }
    const folder = url.searchParams.get('folder');
    const query = (url.searchParams.get('q') || '').toLowerCase().slice(0, 200);
    const matching = all.filter((photo) => (folder === null || photo.folder.toLowerCase() === folder.toLowerCase()) && (!query || `${photo.name} ${photo.owner}`.toLowerCase().includes(query)));
    const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') || '0', 10) || 0);
    const limit = Math.min(300, Math.max(1, Number.parseInt(url.searchParams.get('limit') || '150', 10) || 150));
    const { photos, previewService } = await enrichPhotos(sortPhotos(matching, url.searchParams.get('sort') || 'date', url.searchParams.get('direction') || 'desc').slice(offset, offset + limit));
    return json({ photos, members, previewService, folders: [...folders.values()], total: matching.length, offset, hasMore: offset + photos.length < matching.length });
  } catch (error) { return apiError(error); }
};
