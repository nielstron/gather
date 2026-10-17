import { json } from '@sveltejs/kit';

export function apiError(error: unknown) {
  const candidate = error as { status?: number; message?: string; body?: { message?: string } };
  const status = candidate?.status && candidate.status >= 400 && candidate.status < 600 ? candidate.status : 500;
  if (status === 500) console.error('Gather request failed:', error);
  return json({ error: status === 500 ? 'The server could not complete this request' : candidate.body?.message || candidate.message || 'Request failed' }, { status });
}

export async function boundedText(request: Request, maxBytes = 32_768) {
  if (!request.body) return '';
  const reader = request.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) { await reader.cancel(); throw Object.assign(new Error('Request is too large'), { status: 413 }); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}
