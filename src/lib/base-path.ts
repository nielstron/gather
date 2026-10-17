/** Canonical URL prefix; an empty string serves the app at the origin root. */
export function normalizeBasePath(value = ''): '' | `/${string}` {
  const normalized = value.replace(/\/+$/, '');
  if (!normalized) return '';
  if (!/^\/(?:[A-Za-z0-9_-]+)(?:\/[A-Za-z0-9_-]+)*$/.test(normalized)) {
    throw new Error('GATHER_BASE_PATH must be empty or a URL path such as /gather or /photos/trip');
  }
  return normalized as `/${string}`;
}
