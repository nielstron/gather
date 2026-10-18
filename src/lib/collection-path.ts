/** Collection URLs scope every page, API request, media URL, and download. */
export function collectionIdFromPath(pathname: string, appBase: string): string {
  return pathname.slice(appBase.length).match(/^\/c\/([a-z0-9-]{1,64})(?:\/|$)/)?.[1] || 'default';
}
export function collectionPath(appBase: string, id: string): string {
  return id === 'default' ? appBase : `${appBase}/c/${id}`;
}
export function collectionBase(pathname: string, appBase: string): string {
  return collectionPath(appBase, collectionIdFromPath(pathname, appBase));
}
