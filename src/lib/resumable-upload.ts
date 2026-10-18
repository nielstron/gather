const chunkSize = 1024 * 1024;
export class TransferError extends Error {
  constructor(message: string, public status = 503) { super(message); }
}
export async function transferResumable(options: {
  base: string; id: string; ownerScope: string; file: File; checksum: string; signal: AbortSignal; progress: (percent: number) => void;
}) {
  const { base, id, file, checksum, ownerScope, signal, progress } = options;
  const url = `${base}/api/upload/resumable/${id}`;
  async function send(method: string, body?: BodyInit, extraHeaders: Record<string, string> = {}) {
    const response = await fetch(url, { method, body, headers: extraHeaders, signal: AbortSignal.any([signal, AbortSignal.timeout(method === 'POST' ? 180_000 : 65_000)]) });
    let data;
    try { data = await response.json(); } catch { throw new TransferError('Upload temporarily unavailable.'); }
    if (!response.ok) throw new TransferError(data.error || 'Upload temporarily unavailable.', response.status);
    return data;
  }
  let state = await send('PUT', JSON.stringify({ name: file.name, type: file.type, size: file.size, checksum, ownerScope }), { 'content-type': 'application/json' });
  if (state.photo) return state.photo as { duplicate?: boolean };
  if (!Number.isSafeInteger(state.offset) || state.offset < 0 || state.offset > file.size) throw new TransferError('Invalid upload position.');
  progress(Math.round(state.offset / file.size * 100));
  while (state.offset < file.size) {
    signal.throwIfAborted();
    const end = Math.min(state.offset + chunkSize, file.size);
    const next = await send('PATCH', file.slice(state.offset, end), { 'content-type': 'application/octet-stream', 'upload-offset': String(state.offset) });
    if (next.offset !== end) throw new TransferError('Invalid upload position.');
    state = next;
    progress(Math.round(state.offset / file.size * 100));
  }
  return (await send('POST')).photo as { duplicate?: boolean };
}
