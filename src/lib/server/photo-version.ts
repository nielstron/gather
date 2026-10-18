import { createHash } from 'node:crypto';
export function fileRevision(root: string, relative: string, stat: { size: number; mtimeMs: number; ctimeMs: number }) {
  return createHash('sha256').update(JSON.stringify([root, relative, stat.size, stat.mtimeMs, stat.ctimeMs])).digest('base64url').slice(0, 20);
}
