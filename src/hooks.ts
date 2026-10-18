import { base } from '$app/paths';
import type { Reroute } from '@sveltejs/kit';

// Reuse the same routes under /c/<id>, while preserving the original URL for
// request scoping in the server hook. Build assets remain at the app base.
export const reroute: Reroute = ({ url }) => {
  const local = url.pathname.slice(base.length);
  const match = local.match(/^\/c\/[a-z0-9-]{1,64}(\/.*|$)/);
  if (match) return `${base}${match[1] || '/'}`;
};
