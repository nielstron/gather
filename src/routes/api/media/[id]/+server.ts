import { recordDownloadedPhotos } from '$lib/server/auth';
import { Readable } from 'node:stream';
import path from 'node:path';
import { openPhoto, previewPath, contentDisposition, MediaError } from '$lib/server/media';
import { fetchImmichImage } from '$lib/server/immich';
import { apiError } from '$lib/server/http';
import type { RequestHandler } from './$types';

const browserImages: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif',
};

export const GET: RequestHandler = async ({ params, url, request, locals }) => {
  try {
    const kind = url.searchParams.get('kind') || 'thumbnail';
    if (!['thumbnail', 'preview', 'fullsize', 'original'].includes(kind)) throw new MediaError(400, 'Unknown image size');
    let relative: string;
    if (kind === 'original' || kind === 'fullsize') {
      const file = await openPhoto(params.id);
      const contentType = browserImages[path.extname(file.relative).toLowerCase()];
      if (kind === 'original' || contentType) {
        // A full-resolution display uses the same validated original as downloads,
        // without needing Immich's asset.download permission or buffering the file.
        const source = file.handle.createReadStream();
        if (kind === 'original' && locals?.user) source.once('end', () => {
          try { recordDownloadedPhotos(locals.user!, [{ id: params.id, revision: file.revision }]); }
          catch { console.warn('Gather: could not save download history.'); }
        });
        return new Response(Readable.toWeb(source) as ReadableStream, { headers: {
          'Content-Type': kind === 'original' ? 'application/octet-stream' : contentType,
          'Content-Length': String(file.bytes),
          ...(kind === 'original' ? { 'Content-Disposition': contentDisposition(path.basename(file.relative)) } : {}),
          'Cache-Control': kind === 'original' ? 'private, no-store' : 'private, max-age=60',
        } });
      }
      relative = file.relative;
      await file.handle.close();
    } else relative = await previewPath(params.id);
    // Immich supplies browser-compatible full-size conversions for HEIC, TIFF, etc.
    return await fetchImmichImage(relative, kind as 'thumbnail' | 'preview' | 'fullsize', request.signal);
  } catch (error) { return apiError(error); }
};
