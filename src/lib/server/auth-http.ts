import type { Cookies } from '@sveltejs/kit';
import { config } from './config';

const attempts = new Map<string, { count: number; expires: number }>();
const windowMs = 15 * 60_000;

export function allowAuthAttempt(address: string, scope = 'session', limit = 15) {
  const key = `${scope}:${address}`;
  const now = Date.now();
  const existing = attempts.get(key);
  if (existing && existing.expires > now) {
    if (existing.count >= limit) return false;
    existing.count++;
    return true;
  }
  if (attempts.size >= 5000) {
    for (const [key, bucket] of attempts) if (bucket.expires <= now) attempts.delete(key);
    if (attempts.size >= 5000) return false;
  }
  attempts.set(key, { count: 1, expires: now + windowMs });
  return true;
}

export async function readAuthJson(request: Request): Promise<Record<string, unknown> | null> {
  if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') return null;
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > 1024)) return null;
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1024) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
  } catch { return null; }
  finally { reader.releaseLock(); }
}

export function setSessionCookie(cookies: Cookies, token: string) {
  cookies.set('gather_session', token, {
    path: '/', httpOnly: true, sameSite: 'lax', secure: config.secureCookies,
    maxAge: config.sessionDays * 86400
  });
}
