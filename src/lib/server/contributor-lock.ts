import { config } from './config';
import { createLimiter } from '../async';
type State = { readers: number; waiting: number; writing: boolean; resume: (() => void)[] };
const states = new Map<string, State>();
const memberships = new Map<string, ReturnType<typeof createLimiter>>();
function state(id: string) {
  const key = `${config.photoRoot}:${id}`;
  let value = states.get(key);
  if (!value) { value = { readers: 0, waiting: 0, writing: false, resume: [] }; states.set(key, value); }
  return { key, value };
}
export async function withContributorFiles<T>(id: string, work: () => Promise<T>): Promise<T> {
  const { key, value } = state(id);
  if (value.writing) { value.waiting++; try { while (value.writing) await new Promise<void>(resolve => value.resume.push(resolve)); } finally { value.waiting--; } }
  value.readers++;
  try { return await work(); }
  finally { value.readers--; if (!value.readers && !value.writing && !value.waiting) states.delete(key); }
}
export async function withContributorRename<T>(id: string, work: () => Promise<T>): Promise<T> {
  const { key, value } = state(id);
  if (value.readers || value.waiting || value.writing) throw Object.assign(new Error('Finish your current uploads or deletions before changing your name.'), { status: 409 });
  value.writing = true;
  try { return await work(); }
  finally { value.writing = false; for (const resume of value.resume.splice(0)) resume(); if (!value.readers && !value.waiting) states.delete(key); }
}
export function withMembershipChange<T>(work: () => Promise<T>) {
  let limit = memberships.get(config.photoRoot);
  if (!limit) { limit = createLimiter(1); memberships.set(config.photoRoot, limit); }
  return limit(work);
}
