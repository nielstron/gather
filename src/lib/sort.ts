import type { Photo } from './types';

/** Apply the same stable order before pagination and when rendering the gallery. */
export function sortPhotos(photos: readonly Photo[], field: string, direction: string): Photo[] {
  const multiplier = direction === 'asc' ? 1 : -1;
  return [...photos].sort((a, b) => multiplier * ((field === 'name'
    ? a.name.localeCompare(b.name)
    : Date.parse(a.modifiedAt) - Date.parse(b.modifiedAt)) || a.id.localeCompare(b.id)));
}
