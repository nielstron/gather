import { createSHA256 } from 'hash-wasm';

/** Bound memory while hashing large phone videos before the upload preflight. */
export async function fileChecksum(file: Blob, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const hash = await createSHA256();
  for (let offset = 0; offset < file.size; offset += 1024 * 1024) {
    signal?.throwIfAborted();
    hash.update(new Uint8Array(await file.slice(offset, offset + 1024 * 1024).arrayBuffer()));
  }
  signal?.throwIfAborted();
  return hash.digest('hex');
}
