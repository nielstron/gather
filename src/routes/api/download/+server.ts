import archiver from 'archiver';
import { mapConcurrent } from '$lib/async';
import { PassThrough, Readable } from 'node:stream';
import { openPhoto, contentDisposition, MediaError } from '$lib/server/media';
import { apiError, boundedText } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
  const files: Awaited<ReturnType<typeof openPhoto>>[] = [];
  try {
    const text = await boundedText(request, 128_000);
    let ids: unknown;
    try {
      ids = request.headers.get('content-type')?.includes('application/x-www-form-urlencoded')
        ? JSON.parse(new URLSearchParams(text).get('ids') || 'null') : JSON.parse(text).ids;
    } catch { throw new MediaError(400, 'Invalid download selection'); }
    if (!Array.isArray(ids) || !ids.length || ids.length > 200 || !ids.every((id) => typeof id === 'string')) throw new MediaError(400, 'Select between 1 and 200 photos');
    const ordered = await mapConcurrent([...new Set(ids as string[])], 8, async id => {
      const file = await openPhoto(id);
      files.push(file);
      return file;
    });
    const archive = archiver('zip', { store: true });
    const output = new PassThrough();
    const sources: Readable[] = [];
    const closeFiles = () => { for (const file of files) void file.handle.close().catch(() => {}); };
    archive.on('error', (error) => output.destroy(error));
    archive.on('warning', (error) => output.destroy(error));
    output.on('close', () => { archive.abort(); for (const source of sources) source.destroy(); closeFiles(); });
    archive.pipe(output);
    for (const file of ordered) {
      const source = file.handle.createReadStream();
      source.on('error', (error) => output.destroy(error));
      sources.push(source);
      archive.append(source, { name: file.relative, date: file.modifiedAt });
    }
    void archive.finalize().catch((error) => output.destroy(error));
    return new Response(Readable.toWeb(output) as ReadableStream, { headers: {
      'Content-Type': 'application/zip', 'Content-Disposition': contentDisposition('gather-photos.zip'), 'Cache-Control': 'private, no-store'
    } });
  } catch (error) {
    await Promise.all(files.map((file) => file.handle.close().catch(() => {})));
    return apiError(error);
  }
};
