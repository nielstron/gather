import { json } from '@sveltejs/kit';
import { readdir } from 'node:fs/promises';
import { allowedPhotoRoot, validatePhotoRoot, validateSettings } from '$lib/server/admin';
import { currentCollectionId, createCollection, listCollections, readSettings, writeSettings } from '$lib/server/settings';
import { accessOverview, createMember, createShareLink, resetCollectionAccess, revokeMember, revokeShareLink, rotateMember, rotateShareLink } from '$lib/server/auth';
import path from 'node:path';
import { collectionPath } from '$lib/collection-path';
import { config } from '$lib/server/config';
import { apiError, boundedText } from '$lib/server/http';
import { invalidatePhotos } from '$lib/server/media';
import { requestLibraryScan } from '$lib/server/immich';
import type { RequestHandler } from './$types';

function overview() {
  const { immichApiKey, immichScanApiKey, ...settings } = readSettings();
  return { settings, collectionId: currentCollectionId(), collections: listCollections(), previewKeyConfigured: !!immichApiKey, scanKeyConfigured: !!immichScanApiKey,
    automaticImmichPath: !!process.env.IMMICH_ALLOWED_ROOT, allowedRoot: allowedPhotoRoot(), basePath: collectionPath(config.basePath, currentCollectionId()), origin: config.origin, ...accessOverview() };
}

function invitation(token: string, type: 'share' | 'invite') {
  const url = new URL(`${collectionPath(config.basePath, currentCollectionId())}/`, config.origin);
  url.hash = `${type}=${token}`;
  return url.toString();
}

export const GET: RequestHandler = async ({ url }) => {
  try {
    if (url.searchParams.has('folder')) {
      const folder = validatePhotoRoot(url.searchParams.get('folder') || allowedPhotoRoot());
      const entries = await readdir(folder, { withFileTypes: true });
      return json({ folder, directories: entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => entry.name).sort((a, b) => a.localeCompare(b)) });
    }
    return json(overview());
  } catch (error) { return apiError(error); }
};

export const POST: RequestHandler = async ({ request }) => {
  try {
    const body = JSON.parse(await boundedText(request, 16_384)) as Record<string, unknown>;
    let link: string | undefined;
    let message = '';
    switch (body.action) {
      case 'create-collection': {
        if (typeof body.name !== 'string' || typeof body.photoRoot !== 'string') return json({ error: 'Choose a name and folder for the new collection.' }, { status: 400 });
        const previous = readSettings();
        let immichPhotoRoot = '';
        if (body.inheritConnection === true && previous.immichPhotoRoot) {
          const relative = path.relative(allowedPhotoRoot(), previous.photoRoot).split(path.sep).filter(Boolean);
          let parent = previous.immichPhotoRoot;
          for (const _ of relative) parent = path.posix.dirname(parent);
          immichPhotoRoot = path.posix.join(parent, path.relative(allowedPhotoRoot(), body.photoRoot).split(path.sep).join('/'));
        }
        const settings = validateSettings({ ...previous, collectionName: body.name, photoRoot: body.photoRoot, immichPhotoRoot,
          ...(body.inheritConnection === true ? {} : { immichUrl: '', immichLibraryId: '', immichApiKey: '', immichScanApiKey: '' }) });
        // Blank keys normally preserve saved credentials; a new disconnected collection must start empty.
        if (body.inheritConnection !== true) { settings.immichApiKey = ''; settings.immichScanApiKey = ''; }
        const id = createCollection(settings);
        return json({ collectionId: id, adminUrl: `${collectionPath(config.basePath, id)}/admin`, message: 'Collection created.' }, { status: 201 });
      }

      case 'save': {
        const settings = validateSettings(body.settings as Record<string, unknown>);
        const changedRoot = settings.photoRoot !== readSettings().photoRoot;
        if (changedRoot && body.confirmFolderChange !== true) return json({ error: 'Confirm that changing the collection folder revokes existing invitations and signs everyone out.' }, { status: 400 });
        // Revoke before changing the root, so a failed settings write cannot expose another collection.
        if (changedRoot) resetCollectionAccess();
        writeSettings(settings);
        invalidatePhotos();
        message = changedRoot ? 'Collection saved. Previous invitations and guest sessions were revoked.' : 'Settings saved.';
        break;
      }
      case 'create-share': link = invitation(createShareLink(), 'share'); break;
      case 'rotate-share': link = invitation(rotateShareLink(), 'share'); message = 'Previous shared links and their guest sessions were revoked.'; break;
      case 'revoke-share': revokeShareLink(); message = 'Shared link revoked. Shared-link guests have been signed out.'; break;
      case 'create-member': {
        if (typeof body.name !== 'string' || typeof body.folder !== 'string') throw new Error('Enter a name and folder.');
        link = invitation(createMember(body.name, body.folder).token, 'invite');
        invalidatePhotos();
        break;
      }
      case 'rotate-member':
        if (typeof body.folder !== 'string') throw new Error('Choose a member.');
        link = invitation(rotateMember(body.folder).token, 'invite');
        break;
      case 'revoke-member':
        if (typeof body.folder !== 'string') throw new Error('Choose a member.');
        revokeMember(body.folder); message = 'Member access revoked. Originals are preserved.'; break;
      case 'scan': return json(await requestLibraryScan());
      case 'test-immich': {
        const settings = readSettings();
        if (!settings.immichUrl || !settings.immichApiKey || !settings.immichLibraryId || !settings.immichPhotoRoot) throw new Error('Save the Immich address, library ID, collection path, and preview key first.');
        const response = await fetch(`${settings.immichUrl.replace(/\/+$/, '').replace(/\/api$/, '')}/api/search/metadata`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': settings.immichApiKey },
          body: JSON.stringify({ size: 1, withExif: true, filter: { libraryId: { eq: settings.immichLibraryId } } }),
          signal: AbortSignal.timeout(10_000), redirect: 'error'
        });
        if (!response.ok) { await response.body?.cancel(); throw new Error(`Immich returned HTTP ${response.status}. Check the address and asset.read permission.`); }
        const result = await response.json();
        const asset = result.assets?.items?.[0];
        if (asset && asset.libraryId !== settings.immichLibraryId) throw new Error('Immich did not return assets from the configured library. Check the library ID.');
        return json({ message: asset ? 'Connected. Immich can read assets from the configured library.' : 'Connected. No indexed assets were returned for this library yet.' });
      }
      default: return json({ error: 'Unknown administrator action.' }, { status: 400 });
    }
    return json({ ...overview(), link, message });
  } catch (error) {
    if (error instanceof SyntaxError) return json({ error: 'Invalid request.' }, { status: 400 });
    if (error instanceof Error && !('status' in error)) return json({ error: error.message }, { status: 400 });
    return apiError(error);
  }
};
