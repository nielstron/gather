import archiver from 'archiver';
import { mapConcurrent } from '$lib/async';
import { PassThrough, Readable } from 'node:stream';
import { openPhoto, contentDisposition, MediaError } from '$lib/server/media';
import { recordDownloadedPhotos, takeDownloadTicket } from '$lib/server/auth';
import { chooseDownload, selectedIds } from '$lib/server/download-options';
import { decodeId } from '$lib/server/media';
import { apiError, boundedText } from '$lib/server/http';
import type { RequestHandler } from './$types';

const download: RequestHandler = async ({ request, locals, url }) => {
  const files: Awaited<ReturnType<typeof openPhoto>>[] = [];
  try {
    let input: { ids?: unknown; options?: unknown };
    if (request.method === 'GET') {
      if (!locals?.user) throw new MediaError(401, 'Sign in to download photos.');
      const options = takeDownloadTicket(locals.user, url.searchParams.get('ticket') || '');
      if (!options) throw new MediaError(410, 'This download link has expired. Open download options and try again.');
      input = { options };
    } else {
      const text = await boundedText(request, 128_000);
      try {
        if (request.headers.get('content-type')?.includes('application/x-www-form-urlencoded')) {
          const form = new URLSearchParams(text);
          input = form.has('options') ? { options: JSON.parse(form.get('options')!) } : { ids: JSON.parse(form.get('ids') || 'null') };
        } else input = JSON.parse(text);
      } catch { throw new MediaError(400, 'Invalid download selection'); }
    }
    const filtered = input?.options !== undefined;
    if (filtered && !locals?.user) throw new MediaError(401, 'Sign in to download photos.');
    const photos = filtered ? await chooseDownload(locals.user!, input.options) : undefined;
    const ids = photos ? photos.map(photo => photo.id) : selectedIds(input?.ids);
    if (!ids?.length) throw new MediaError(400, 'Select between 1 and 200 photos');
    // Legacy explicit selections retain their up-front validation. Larger filtered
    // archives open originals only as they stream, keeping memory and handles bounded.
    const opened = photos ? undefined : await mapConcurrent(ids, 8, async id => { const file = await openPhoto(id); files.push(file); return file; });
    const archive = archiver('zip', { store: true });
    const output = new PassThrough();
    const sources: Readable[] = [];
    const completed: { id: string; revision: string }[] = [];
    let failed = false;
    archive.on('error', error => { failed = true; output.destroy(error); });
    archive.on('warning', error => { failed = true; output.destroy(error); });
    output.once('end', () => {
      if (!failed && completed.length === ids.length && locals?.user) {
        try { recordDownloadedPhotos(locals.user, completed); }
        catch { console.warn('Gather: could not save download history.'); }
      }
    });
    output.on('close', () => { archive.abort(); for (const source of sources) source.destroy(); for (const file of files) void file.handle.close().catch(() => {}); });
    archive.pipe(output);
    for (const [index, id] of ids.entries()) {
      const source = Readable.from((async function* () {
        const file = opened?.[index] || await openPhoto(id);
        if (!opened) files.push(file);
        try {
          yield* file.handle.createReadStream({ autoClose: false });
          completed.push({ id, revision: file.revision });
        } finally { await file.handle.close().catch(() => {}); const position = files.indexOf(file); if (position >= 0) files.splice(position, 1); }
      })());
      source.on('error', error => { failed = true; output.destroy(error); });
      sources.push(source);
      archive.append(source, { name: opened?.[index].relative || decodeId(id), date: opened?.[index].modifiedAt || new Date(photos![index].modifiedAt) });
    }
    void archive.finalize().catch(error => { failed = true; output.destroy(error); });
    const iterator = output[Symbol.asyncIterator]();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const result = await iterator.next();
          if (cancelled) return;
          if (result.done) controller.close(); else controller.enqueue(result.value);
        } catch (error) { if (!cancelled) controller.error(error); }
      },
      async cancel() {
        cancelled = true; failed = true; output.destroy();
        try { await iterator.return?.(); } catch { /* A cancelled stream may already be destroyed. */ }
      }
    });
    return new Response(body, { headers: {
      'Content-Type': 'application/zip', 'Content-Disposition': contentDisposition('gather-photos.zip'), 'Cache-Control': 'private, no-store'
    } });
  } catch (error) {
    await Promise.all(files.map(file => file.handle.close().catch(() => {})));
    return apiError(error);
  }
};

export const POST = download;
export const GET = download;
