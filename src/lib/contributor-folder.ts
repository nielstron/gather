/** A display name is also a safe, human-readable directory name. */
export function contributorName(value: string) {
  const name = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (/[\x00-\x1f\x7f]/.test(value) || !name || name.length > 80 || utf8Length(name) > 200 || /[\x00-\x1f\x7f/\\:*?"<>|]/.test(name) || name.startsWith('.') || name.endsWith('.')) throw new Error('Use 1–80 characters without path separators or reserved filename characters.');
  return name;
}
function utf8Length(value: string) { return new TextEncoder().encode(value).length; }
export function contributorFolder(value: string) {
  return contributorName(value).replace(/\p{L}/u, letter => letter.toUpperCase());
}
export function contributorKey(value: string) { return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase(); }
