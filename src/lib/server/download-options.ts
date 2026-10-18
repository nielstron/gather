import { listMembers, downloadedPhotos } from './auth';
import { scanPhotos, MediaError } from './media';
import type { Member, Photo } from '../types';
export type DownloadChoice = { folders: string[]; updatesOnly: boolean; ids?: string[] };
export function selectedIds(input: unknown): string[] | undefined {
  if (input === undefined) return;
  if (!Array.isArray(input) || !input.length || input.length > 200 || !input.every(id => typeof id === 'string')) throw new MediaError(400, 'Select between 1 and 200 photos');
  return [...new Set(input as string[])];
}
export async function downloadInventory(member: Member, ids?: string[]) {
  const members = listMembers();
  const all = await scanPhotos(members);
  const selected = ids ? new Set(ids) : undefined;
  const photos = selected ? all.filter(photo => selected.has(photo.id)) : all;
  if (selected && photos.length !== selected.size) throw new MediaError(404, 'Some selected photos are no longer available. Refresh the collection.');
  const history = downloadedPhotos(member);
  const contributors = new Map<string, { folder: string; name: string; count: number; bytes: number; updates: number; updatedBytes: number }>();
  for (const user of members) contributors.set(user.folder.toLowerCase(), { folder: user.folder.toLowerCase(), name: user.name, count: 0, bytes: 0, updates: 0, updatedBytes: 0 });
  for (const photo of photos) {
    const folder = photo.folder.toLowerCase();
    let entry = contributors.get(folder);
    if (!entry) { entry = { folder, name: photo.owner || 'Shared folder', count: 0, bytes: 0, updates: 0, updatedBytes: 0 }; contributors.set(folder, entry); }
    entry.count++; entry.bytes += photo.bytes;
    if (!photo.revision || history.get(photo.id) !== photo.revision) { entry.updates++; entry.updatedBytes += photo.bytes; }
  }
  return { photos, history, contributors: [...contributors.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}
export async function chooseDownload(member: Member, input: unknown): Promise<Photo[]> {
  const choice = input as DownloadChoice;
  if (!choice || !Array.isArray(choice.folders) || !choice.folders.length || choice.folders.length > 1024 || !choice.folders.every(folder => typeof folder === 'string' && folder.length <= 4096) || typeof choice.updatesOnly !== 'boolean') throw new MediaError(400, 'Choose at least one contributor.');
  const inventory = await downloadInventory(member, selectedIds(choice.ids));
  const folders = new Set(choice.folders.map(folder => folder.toLowerCase()));
  const photos = inventory.photos.filter(photo => folders.has(photo.folder.toLowerCase()) && (!choice.updatesOnly || !photo.revision || inventory.history.get(photo.id) !== photo.revision));
  if (!photos.length) throw new MediaError(400, choice.updatesOnly ? 'There are no new or changed photos for these contributors.' : 'There are no photos for these contributors.');
  return photos;
}
