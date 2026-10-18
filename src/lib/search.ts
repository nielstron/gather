// Current Immich structured search fields (v3.2+). The same catalog drives UI and validation.
export type SearchKind = 'text' | 'pattern' | 'uuid' | 'ids' | 'number' | 'date' | 'boolean' | 'ocr' | 'enum';
export type SearchField = { key: string; label: string; kind: SearchKind; nullable?: boolean; values?: string[] };
export const searchFields: SearchField[] = [
  { key: 'personIds', label: 'People', kind: 'ids' },
  { key: 'hasPeople', label: 'Has recognized faces', kind: 'boolean' },
  { key: 'takenAt', label: 'Date taken', kind: 'date' },
  { key: 'city', label: 'City', kind: 'text', nullable: true },
  { key: 'state', label: 'State / province', kind: 'text', nullable: true },
  { key: 'country', label: 'Country', kind: 'text', nullable: true },
  { key: 'description', label: 'Description', kind: 'pattern', nullable: true },
  { key: 'originalFileName', label: 'Filename', kind: 'pattern', nullable: true },
  { key: 'ocr', label: 'Text in image (OCR)', kind: 'ocr' },
  { key: 'make', label: 'Camera make', kind: 'text', nullable: true },
  { key: 'model', label: 'Camera model', kind: 'text', nullable: true },
  { key: 'lensModel', label: 'Lens', kind: 'text', nullable: true },
  { key: 'rating', label: 'Rating', kind: 'number', nullable: true },
  { key: 'isFavorite', label: 'Favorite', kind: 'boolean' },
  { key: 'type', label: 'Media type', kind: 'enum', values: ['IMAGE', 'VIDEO', 'AUDIO', 'OTHER'] },
  { key: 'visibility', label: 'Visibility', kind: 'enum', values: ['timeline', 'archive', 'hidden', 'locked'] },
  { key: 'fileSizeInBytes', label: 'File size (bytes)', kind: 'number' },
  { key: 'createdAt', label: 'Date imported', kind: 'date' },
  { key: 'updatedAt', label: 'Date updated', kind: 'date' },
  { key: 'trashedAt', label: 'Date trashed', kind: 'date', nullable: true },
  { key: 'isMotion', label: 'Motion photo', kind: 'boolean' },
  { key: 'isOffline', label: 'Offline', kind: 'boolean' },
  { key: 'isEncoded', label: 'Encoded video', kind: 'boolean' },
  { key: 'hasAlbums', label: 'In an album', kind: 'boolean' },
  { key: 'albumIds', label: 'Album IDs', kind: 'ids' },
  { key: 'hasTags', label: 'Has tags', kind: 'boolean' },
  { key: 'tagIds', label: 'Tag IDs', kind: 'ids' },
  { key: 'originalPath', label: 'Original path', kind: 'pattern', nullable: true },
  { key: 'checksum', label: 'Immich checksum', kind: 'text' },
  { key: 'id', label: 'Asset ID', kind: 'uuid' },
  { key: 'libraryId', label: 'Library ID', kind: 'uuid', nullable: true },
  { key: 'encodedVideoPath', label: 'Encoded video path', kind: 'text' },
];
export const operatorLabels: Record<string, string> = { eq: 'is', ne: 'is not', in: 'is one of', notIn: 'is none of', like: 'matches pattern', notLike: 'does not match pattern', startsWith: 'starts with', endsWith: 'ends with', lt: 'before / less than', lte: 'at most / on or before', gt: 'after / greater than', gte: 'at least / on or after', any: 'includes any', all: 'includes all', none: 'includes none', matches: 'contains text' };
export function operators(field: SearchField): string[] {
  if (field.kind === 'ids') return ['all', 'any', 'none'];
  if (field.kind === 'boolean') return ['eq'];
  if (field.kind === 'ocr') return ['matches'];
  if (field.kind === 'uuid') return ['eq', 'ne'];
  if (field.kind === 'date') return ['gte', 'lte', 'gt', 'lt', 'eq', 'ne'];
  if (field.kind === 'number') return ['eq', 'ne', 'gte', 'lte', 'gt', 'lt', 'in', 'notIn'];
  return ['eq', 'ne', 'in', 'notIn', ...(field.kind === 'pattern' ? ['like', 'notLike', 'startsWith', 'endsWith'] : [])];
}
export type SearchBranch = Record<string, Record<string, unknown>>;
export type CollectionSearch = { mode: 'semantic' | 'filename' | 'metadata'; filter?: Record<string, unknown>; language?: string; queryAssetId?: string; withStacked?: boolean; resultLimit?: number; orderBy?: { field: string; direction: 'asc' | 'desc' } };
export type SearchPerson = { id: string; name: string; photoId: string; revision?: string; count: number };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function invalid(message = 'Invalid search filter'): never { throw Object.assign(new Error(message), { status: 400 }); }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
export function validateSearch(input: unknown): CollectionSearch {
  if (!object(input) || !['semantic', 'filename', 'metadata'].includes(String(input.mode))) invalid('Choose a search mode');
  if (Object.keys(input).some(key => !['mode', 'filter', 'language', 'queryAssetId', 'withStacked', 'resultLimit', 'orderBy'].includes(key))) invalid();
  const branch = (value: unknown, allowOr: boolean) => {
    if (!object(value) || (!allowOr && !Object.keys(value).length) || Object.keys(value).length > 40) invalid();
    for (const [key, condition] of Object.entries(value)) {
      if (key === 'or' && allowOr) {
        if (!Array.isArray(condition) || !condition.length || condition.length > 10) invalid();
        for (const child of condition) branch(child, false);
        continue;
      }
      const field = searchFields.find(field => field.key === key);
      if (!field || !object(condition) || !Object.keys(condition).length) invalid();
      for (const [op, operand] of Object.entries(condition)) {
        if (!operators(field).includes(op)) invalid(`Invalid operator for ${field.label}`);
        const list = ['in', 'notIn', 'any', 'all', 'none'].includes(op);
        if (list && (!Array.isArray(operand) || !operand.length || operand.length > 200)) invalid();
        for (const item of list ? operand as unknown[] : [operand]) {
          if (item === null && field.nullable && ['eq', 'ne'].includes(op)) continue;
          if (field.kind === 'boolean') { if (typeof item !== 'boolean') invalid(); }
          else if (field.kind === 'number') { if (typeof item !== 'number' || !Number.isFinite(item)) invalid(); }
          else {
            if (typeof item !== 'string' || item.length > 4096) invalid();
            if (['uuid', 'ids'].includes(field.kind) && !uuid.test(item)) invalid('Use a valid Immich ID');
            if (field.kind === 'enum' && !field.values!.includes(item)) invalid();
            if (field.kind === 'date' && (!/^\d{4}-\d\d-\d\dT/.test(item) || !Number.isFinite(Date.parse(item)))) invalid('Use a valid date and time');
          }
        }
      }
    }
  };
  if (input.filter !== undefined) branch(input.filter, true);
  if (input.language !== undefined && (typeof input.language !== 'string' || input.language.length > 40)) invalid();
  if (input.queryAssetId !== undefined && (typeof input.queryAssetId !== 'string' || !uuid.test(input.queryAssetId))) invalid('Use a valid reference asset ID');
  if (input.withStacked !== undefined && typeof input.withStacked !== 'boolean') invalid();
  if (input.resultLimit !== undefined && (!Number.isSafeInteger(input.resultLimit) || Number(input.resultLimit) < 1 || Number(input.resultLimit) > 1000)) invalid('Semantic result limit must be between 1 and 1000');
  if (input.orderBy !== undefined && (!object(input.orderBy) || !['fileCreatedAt', 'localDateTime', 'fileSizeInBytes', 'rating'].includes(String(input.orderBy.field)) || !['asc', 'desc'].includes(String(input.orderBy.direction)))) invalid();
  return input as CollectionSearch;
}
