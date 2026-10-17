import { Readable } from 'node:stream';
import path from 'node:path';
import { openPhoto, previewPath, contentDisposition, MediaError } from '$lib/server/media';
import { fetchImmichImage } from '$lib/server/immich';
import { apiError } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, url, request }) => {
  try {
    const kind = url.searchParams.get('kind') || 'thumbnail';
    if (!['thumbnail', 'preview', 'original'].includes(kind)) throw new MediaError(400, 'Unknown image size');
    if (kind === 'original') {
      const file = await openPhoto(params.id);
      return new Response(Readable.toWeb(file.handle.createReadStream()) as ReadableStream, { headers: {
        'Content-Type': 'application/octet-stream', 'Content-Length': String(file.bytes),
        'Content-Disposition': contentDisposition(path.basename(file.relative)), 'Cache-Control': 'private, no-store'
      } });
    }
    const relative = await previewPath(params.id);
    return await fetchImmichImage(relative, kind as 'thumbnail' | 'preview', request.signal);
  } catch (error) { return apiError(error); }
};
