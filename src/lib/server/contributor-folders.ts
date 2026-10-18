import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, readdir, rename, link, unlink, rmdir, readFile, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { config } from './config';
import { collectionDataRoot, readSettings } from './settings';
import { memberDatabase, AuthError } from './auth';
import { contributorFolder, contributorKey } from '../contributor-folder';
import { fileRevision } from './photo-version';
import { mapConcurrent } from '../async';
import { withContributorRename } from './contributor-lock';
import type { Member } from '../types';

type RawMember = Member & { merged_into?: string; active: number; shared: number; invite_hash: string | null; scope_seed: string };
type Group = { member: RawMember; sources: RawMember[]; folders: string[]; target: string; name: string };
type Move = { from: string; to: string; size: number; mtime: number; oldRevision: string; revision?: string; directory: boolean };
type Plan = { root: string; groups: Group[]; moves: Move[]; directories: string[]; renames: { from: string; to: string; temporary: string }[]; cleanup: string[]; folders: Record<string, string>; committed?: boolean };
const ready = new Map<string, Promise<void>>();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const id = (relative: string) => Buffer.from(relative).toString('base64url');
const filename = () => path.join(collectionDataRoot(), 'folder-journal.json');
async function stat(relative: string) { try { return await lstat(path.join(config.photoRoot, relative)); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } }
async function contentHash(relative: string) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path.join(config.photoRoot, relative))) digest.update(chunk);
  return digest.digest('hex');
}
async function persist(plan: Plan) {
  const temporary = filename() + '.tmp';
  await writeFile(temporary, JSON.stringify(plan), { mode: 0o600 });
  await rename(temporary, filename());
}
function safeLeaf(value: string) { if (!value || value.startsWith('.') || /[/\\\x00-\x1f\x7f]/.test(value)) throw new AuthError(409, 'An existing contributor folder is not a safe directory name.'); }
async function inventory(folder: string) {
  safeLeaf(folder);
  const files: { relative: string; size: number; mtime: number; revision: string }[] = [], directories: string[] = [];
  const pending = [folder];
  for (let index = 0; index < pending.length; index++) {
    const directory = pending[index], info = await stat(directory);
    if (!info) continue;
    if (!info.isDirectory() || info.isSymbolicLink()) throw new AuthError(409, `Folder ${folder} contains an unsupported link or file.`);
    directories.push(directory);
    const entries = await readdir(path.join(config.photoRoot, directory), { withFileTypes: true });
    await mapConcurrent(entries, 4, async entry => {
      const relative = path.join(directory, entry.name), info = await stat(relative);
      if (!info) throw new AuthError(409, 'A contributor folder changed while preparing its rename. Retry.');
      if (info.isSymbolicLink() || !info.isFile() && !info.isDirectory()) throw new AuthError(409, `Folder ${folder} contains an unsupported link or file.`);
      if (info.isDirectory()) pending.push(relative);
      else files.push({ relative, size: info.size, mtime: info.mtimeMs, revision: fileRevision(config.photoRoot, relative, info) });
    });
  }
  return { files, directories };
}
async function planFolders(groups: Group[], extras: { sources: string[]; target: string }[] = []): Promise<Plan> {
  const plan: Plan = { root: config.photoRoot, groups, moves: [], directories: [], renames: [], cleanup: [], folders: {} };
  const entries = await readdir(config.photoRoot, { withFileTypes: true });
  const spelling = new Set(entries.map(entry => entry.name));
  const targets = new Set<string>();
  for (const group of groups) {
    const key = contributorKey(group.target);
    if (targets.has(key)) throw new AuthError(409, 'Two contributors would share the same capitalized folder. Choose distinct names before migration.');
    targets.add(key);
  }
  const owners = new Map(groups.flatMap(group => group.folders.map(folder => [contributorKey(folder), group.member.id] as const)));
  for (const group of groups) {
    const owner = owners.get(contributorKey(group.target));
    if (owner && owner !== group.member.id) throw new AuthError(409, `Folder ${group.target} is assigned to another contributor. Resolve that conflict before renaming folders.`);
  }
  for (const group of [...groups.map(group => ({ sources: group.folders, target: group.target })), ...extras]) {
    safeLeaf(group.target);
    const sources = [...new Set([...group.sources, ...entries.filter(entry => contributorKey(entry.name) === contributorKey(group.target)).map(entry => entry.name)])];
    const trees = await Promise.all(sources.map(async source => ({ source, ...await inventory(source) })));
    const primary = spelling.has(group.target) ? group.target : trees.find(tree => tree.directories.length)?.source;
    const used = new Map<string, string>(), directories = new Set<string>();
    if (primary && primary !== group.target) plan.renames.push({ from: primary, to: group.target, temporary: `.gather-folder-${randomUUID()}` });
    if (!primary && !readSettings().readOnly) directories.add(group.target);
    // The existing target wins filename spelling; collisions always get a new, reserved name.
    trees.sort((a, b) => Number(b.source === primary) - Number(a.source === primary));
    for (const tree of trees) {
      plan.folders[tree.source.toLowerCase()] = group.target.toLowerCase();
      for (const directory of tree.directories) directories.add(path.join(group.target, path.relative(tree.source, directory)));
      for (const file of tree.files.sort((a, b) => a.relative.localeCompare(b.relative))) {
        const desired = path.join(group.target, path.relative(tree.source, file.relative));
        let target = desired, suffix = 1;
        while (tree.source !== primary && (used.has(contributorKey(target)) || directories.has(target))) {
          const extension = path.extname(desired), stem = path.basename(desired, extension);
          target = path.join(path.dirname(desired), `${stem} (${++suffix})${extension}`);
          if (Buffer.byteLength(path.basename(target)) > 255) throw new AuthError(409, 'A filename collision needs a shorter filename before folders can be combined.');
        }
        used.set(contributorKey(target), file.relative);
        if (file.relative !== target) plan.moves.push({ from: file.relative, to: target, size: file.size, mtime: file.mtime, oldRevision: file.revision, directory: tree.source === primary && primary !== group.target });
      }
      if (tree.source !== group.target && tree.source !== primary) plan.cleanup.push(...tree.directories);
    }
    plan.directories.push(...directories);
  }
  return plan;
}
async function execute(plan: Plan) {
  if (plan.root !== config.photoRoot) throw new AuthError(503, 'A folder rename is pending for a different collection root.');
  if (!plan.committed) {
    for (const operation of plan.renames) {
      if (await stat(operation.from)) {
        if (await stat(operation.temporary)) throw new AuthError(409, 'A folder rename recovery path is already occupied.');
        await rename(path.join(plan.root, operation.from), path.join(plan.root, operation.temporary));
      }
      if (await stat(operation.temporary)) {
        if (await stat(operation.to)) throw new AuthError(409, 'The destination folder appeared during its rename. Originals are preserved.');
        await rename(path.join(plan.root, operation.temporary), path.join(plan.root, operation.to));
      }
    }
    for (const directory of [...new Set(plan.directories)].sort((a, b) => a.split(path.sep).length - b.split(path.sep).length)) {
      await mkdir(path.join(plan.root, directory), { recursive: true });
      const info = await stat(directory);
      if (!info?.isDirectory() || info.isSymbolicLink()) throw new AuthError(409, 'A destination is not a regular directory.');
    }
    await mapConcurrent(plan.moves, 4, async move => {
      if (!move.directory) {
        const source = await stat(move.from), target = await stat(move.to);
        if (source) {
          if (!source.isFile() || source.isSymbolicLink() || source.size !== move.size || source.mtimeMs !== move.mtime) throw new AuthError(409, 'An original changed during the folder rename. No file will be overwritten.');
          // SSHFS assigns different synthetic inodes to hardlinks. On recovery,
          // verify existing destinations by content when inode identity is unavailable.
          if (target && (source.ino !== target.ino || source.dev !== target.dev) && (!target.isFile() || target.isSymbolicLink() || source.size !== target.size || await contentHash(move.from) !== await contentHash(move.to))) throw new AuthError(409, 'A destination file appeared during the folder rename. Originals are preserved.');
          if (!target) await link(path.join(plan.root, move.from), path.join(plan.root, move.to));
          const linked = await stat(move.to);
          if (!linked?.isFile() || linked.isSymbolicLink() || linked.size !== source.size || linked.mtimeMs !== source.mtimeMs) throw new AuthError(409, 'Could not verify a moved original. Both paths are preserved.');
          await unlink(path.join(plan.root, move.from));
        }
      }
      const info = await stat(move.to);
      if (!info?.isFile() || info.isSymbolicLink() || info.size !== move.size || info.mtimeMs !== move.mtime) throw new AuthError(409, 'A moved original could not be verified. The folder journal was retained.');
      move.revision = fileRevision(plan.root, move.to, info);
    });
    await persist(plan);
    commit(plan);
    plan.committed = true; await persist(plan);
  }
  for (const directory of [...new Set(plan.cleanup)].sort((a, b) => b.split(path.sep).length - a.split(path.sep).length)) {
    try { await rmdir(path.join(plan.root, directory)); } catch (error) { if (!['ENOENT'].includes((error as NodeJS.ErrnoException).code || '')) throw error; }
  }
  await writeFile(path.join(collectionDataRoot(), 'last-folder-migration.json'), JSON.stringify(plan), { mode: 0o600 });
  await unlink(filename());
  const { invalidatePhotos } = await import('./media'); invalidatePhotos();
  if (plan.moves.length || plan.renames.length) { const { requestLibraryScan } = await import('./immich'); void requestLibraryScan().catch(() => {}); }
}
function commit(plan: Plan) {
  const database = memberDatabase();
  const remapped = new Map(plan.moves.map(move => [id(move.from), move]));
  const scopeMap = new Map<string, string>();
  const canonicalFolders = new Map<string, { folder: string; name?: string }>();
  for (const group of plan.groups) for (const folder of [...group.folders, group.target]) canonicalFolders.set(folder.toLowerCase(), { folder: group.target, name: group.name });
  for (const move of plan.moves) if (!canonicalFolders.has(move.from.split(path.sep)[0].toLowerCase())) canonicalFolders.set(move.from.split(path.sep)[0].toLowerCase(), { folder: move.to.split(path.sep)[0] });
  for (const group of plan.groups) for (const source of group.sources) scopeMap.set(hash([plan.root, source.id, source.scope_seed || source.folder, 'downloads']), hash([plan.root, group.member.id, group.member.scope_seed || group.member.folder, 'downloads']));
  database.transaction(() => {
    const histories = database.prepare('SELECT * FROM download_history').all() as { scope: string; photo_id: string; revision: string; downloaded_at: number }[];
    database.prepare('DELETE FROM download_history').run();
    const history = database.prepare('INSERT INTO download_history VALUES (?,?,?,?) ON CONFLICT(scope,photo_id) DO UPDATE SET revision=excluded.revision,downloaded_at=excluded.downloaded_at WHERE excluded.downloaded_at >= download_history.downloaded_at');
    for (const record of histories) {
      const move = remapped.get(record.photo_id);
      history.run(scopeMap.get(record.scope) || record.scope, move ? id(move.to) : record.photo_id, move && record.revision === move.oldRevision ? move.revision : record.revision, record.downloaded_at);
    }
    for (const move of plan.moves) {
      const previous = hash([plan.root, move.from]), next = hash([plan.root, move.to]);
      const cached = database.prepare('SELECT checksum FROM file_checksums WHERE scope=? AND revision=?').get(previous, move.oldRevision) as { checksum: string } | undefined;
      database.prepare('DELETE FROM file_checksums WHERE scope=?').run(previous);
      if (cached) database.prepare('INSERT OR REPLACE INTO file_checksums VALUES (?,?,?)').run(next, move.revision, cached.checksum);
    }
    for (const row of database.prepare('SELECT scope,photo FROM upload_receipts').all() as { scope: string; photo: string }[]) {
      const photo = JSON.parse(row.photo), move = remapped.get(photo.id);
      const canonical = canonicalFolders.get(String(photo.folder).toLowerCase());
      if (!move && !canonical) continue;
      if (move && photo.revision !== move.oldRevision) { database.prepare('DELETE FROM upload_receipts WHERE scope=?').run(row.scope); continue; }
      if (move) Object.assign(photo, { id: id(move.to), revision: move.revision, name: path.basename(move.to), folder: move.to.split(path.sep)[0] });
      if (canonical) { photo.folder = canonical.folder; if (canonical.name) photo.owner = canonical.name; }
      database.prepare('UPDATE upload_receipts SET photo=? WHERE scope=?').run(JSON.stringify(photo), row.scope);
    }
    for (const row of database.prepare('SELECT token_hash,choice,scope FROM download_tickets').all() as { token_hash: string; choice: string; scope: string }[]) {
      const choice = JSON.parse(row.choice);
      if (Array.isArray(choice.folders)) choice.folders = [...new Set(choice.folders.map((folder: string) => plan.folders[folder.toLowerCase()] || folder))];
      if (Array.isArray(choice.ids)) choice.ids = choice.ids.map((photoId: string) => remapped.has(photoId) ? id(remapped.get(photoId)!.to) : photoId);
      database.prepare('UPDATE download_tickets SET choice=?,scope=? WHERE token_hash=?').run(JSON.stringify(choice), scopeMap.get(row.scope) || row.scope, row.token_hash);
    }
    for (const group of plan.groups) {
      for (const source of group.sources) {
        if (!source.active) database.prepare('DELETE FROM sessions WHERE member_id=?').run(source.id);
        else database.prepare('UPDATE sessions SET member_id=?,shared=MAX(shared,?) WHERE member_id=?').run(group.member.id, source.shared, source.id);
        if (source.id === group.member.id) continue;
        if (source.active && source.invite_hash) database.prepare('INSERT OR IGNORE INTO member_invites VALUES (?,?)').run(source.invite_hash, group.member.id);
        database.prepare('UPDATE member_invites SET member_id=? WHERE member_id=?').run(group.member.id, source.id);
      }
    }
    database.exec('DROP TABLE IF EXISTS member_folders');
    for (const group of plan.groups) for (const source of group.sources) if (source.id !== group.member.id) database.prepare('DELETE FROM members WHERE id=?').run(source.id);
    // Temporary unique values allow case-only folder changes in the same transaction.
    for (const group of plan.groups) database.prepare('UPDATE members SET folder=? WHERE id=?').run(`migration-${group.member.id}`, group.member.id);
    for (const group of plan.groups) database.prepare('UPDATE members SET name=?,folder=?,scope_seed=? WHERE id=?').run(group.name, group.target, group.member.scope_seed || group.member.folder, group.member.id);
    const columns = database.prepare('PRAGMA table_info(members)').all() as { name: string }[];
    if (columns.some(column => column.name === 'merged_into')) database.exec('ALTER TABLE members DROP COLUMN merged_into');
    database.pragma('user_version = 4');
  })();
}
async function run(plan: Plan) {
  if (plan.moves.length || plan.renames.length || plan.groups.length) {
    const backup = path.join(collectionDataRoot(), `folders-before-${Date.now()}-${randomUUID()}.sqlite`);
    await memberDatabase().backup(backup); await chmod(backup, 0o600);
    // Retain the original migration backup and the latest four rename snapshots.
    const backups = (await readdir(collectionDataRoot())).filter(name => /^folders-before-\d+-[a-f0-9-]+\.sqlite$/.test(name)).sort();
    for (const name of backups.slice(1, -4)) await unlink(path.join(collectionDataRoot(), name));
  }
  try { await persist(plan); await execute(plan); }
  catch (error) { ready.delete(`${collectionDataRoot()}:${config.photoRoot}`); throw error; }
}
export function ensureCanonicalFolders(): Promise<void> {
  const key = `${collectionDataRoot()}:${config.photoRoot}`;
  let work = ready.get(key);
  if (!work) {
    work = (async () => {
      const database = memberDatabase();
      await mkdir(config.photoRoot, { recursive: true });
      const root = await lstat(config.photoRoot);
      if (!root.isDirectory() || root.isSymbolicLink()) throw new AuthError(409, 'The collection root must be a real directory.');
      try { const pending: Plan = JSON.parse(await readFile(filename(), 'utf8')); await execute(pending); return; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const members = database.prepare('SELECT * FROM members ORDER BY active DESC,shared,created_at,rowid').all() as RawMember[];
      const byId = new Map(members.map(member => [member.id, member]));
      const groups = new Map<string, Group>(), byName = new Map<string, string>();
      for (const member of members.filter(member => !member.merged_into)) {
        const key = contributorKey(member.name), previous = byName.get(key);
        if (!previous) { byName.set(key, member.id); groups.set(member.id, { member, sources: [], folders: [], target: contributorFolder(member.name), name: member.name }); }
      }
      const aliasTable = !!database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='member_folders'").get();
      const aliases = aliasTable ? database.prepare('SELECT * FROM member_folders').all() as { folder: string; member_id: string }[] : [];
      for (const member of members) {
        let owner = member; const seen = new Set<string>();
        while (owner.merged_into && byId.has(owner.merged_into) && !seen.has(owner.id)) { seen.add(owner.id); owner = byId.get(owner.merged_into)!; }
        const group = groups.get(byName.get(contributorKey(owner.name))!)!;
        if (!group) throw new AuthError(409, 'A legacy contributor could not be resolved safely.');
        group.sources.push(member); group.folders.push(member.folder, ...aliases.filter(alias => alias.member_id === member.id).map(alias => alias.folder));
      }
      const entries = await readdir(config.photoRoot, { withFileTypes: true });
      for (const group of groups.values()) group.folders.push(...entries.filter(entry => contributorKey(entry.name) === contributorKey(group.member.name)).map(entry => entry.name));
      if (database.pragma('user_version', { simple: true }) === 4 && [...groups.values()].every(group => group.sources.length === 1 && group.member.folder === group.target && new Set(group.folders).size === 1)) return;
      await run(await planFolders([...groups.values()]));
    })().catch(error => { ready.delete(key); throw error; });
    ready.set(key, work);
  }
  return work;
}
export async function claimContributorFolder(folder: string) {
  safeLeaf(folder);
  const entries = await readdir(config.photoRoot, { withFileTypes: true });
  const matches = entries.filter(entry => contributorKey(entry.name) === contributorKey(folder));
  if (matches.some(entry => !entry.isDirectory() || entry.isSymbolicLink())) throw new AuthError(409, 'This name does not match a shareable directory.');
  if (matches.length && (matches.length > 1 || matches[0].name !== folder)) {
    if (readSettings().readOnly) throw new AuthError(403, 'Ask the administrator to capitalize this existing folder before sharing it read-only.');
    await run(await planFolders([], [{ sources: matches.map(entry => entry.name), target: folder }]));
  } else if (!readSettings().readOnly) await mkdir(path.join(config.photoRoot, folder), { recursive: true });
}
export async function renameContributorFolder(member: Member, name: string) {
  if (readSettings().readOnly) throw new AuthError(403, 'Names and folders cannot be changed in a read-only collection.');
  return withContributorRename(member.id, async () => {
    const target = contributorFolder(name), database = memberDatabase();
    if (target === member.folder) { database.prepare('UPDATE members SET name=? WHERE id=?').run(name, member.id); return; }
    const entries = await readdir(config.photoRoot, { withFileTypes: true });
    const occupied = entries.find(entry => contributorKey(entry.name) === contributorKey(target) && contributorKey(entry.name) !== contributorKey(member.folder));
    if (occupied && (!occupied.isDirectory() || (await readdir(path.join(config.photoRoot, occupied.name))).length)) throw new AuthError(409, 'That folder already contains files. Choose a different name.');
    const record = database.prepare('SELECT * FROM members WHERE id=?').get(member.id) as RawMember;
    await run(await planFolders([{ member: record, sources: [record], folders: [member.folder], target, name }]));
  });
}
