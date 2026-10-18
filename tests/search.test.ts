import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchFields, operators, validateSearch } from '../src/lib/search';
const id = '11111111-1111-4111-8111-111111111111';
test('every supported Immich structured field and operator can be configured', () => {
  assert.equal(searchFields.length, 32);
  for (const field of searchFields) {
    for (const op of operators(field)) {
      let value: unknown = ['uuid', 'ids'].includes(field.kind) ? id : field.kind === 'number' ? 3 : field.kind === 'boolean' ? true : field.kind === 'date' ? '2026-10-01T00:00:00Z' : field.values?.[0] || 'value';
      if (['in', 'notIn', 'all', 'any', 'none'].includes(op)) value = [value];
      const input = { mode: 'semantic', filter: { [field.key]: { [op]: value } } };
      assert.deepEqual(validateSearch(input), input, `${field.key}.${op}`);
    }
    if (field.nullable) assert.doesNotThrow(() => validateSearch({ mode: 'metadata', filter: { [field.key]: { eq: null } } }));
  }
});
test('search accepts alternatives and rejects malformed fields, operands, and limits', () => {
  assert.doesNotThrow(() => validateSearch({ mode: 'semantic', filter: { personIds: { all: [id] }, or: [{ city: { eq: 'Berlin' } }, { hasPeople: { eq: true } }] }, language: 'de', resultLimit: 200, queryAssetId: id }));
  for (const filter of [{ secret: { eq: true } }, { personIds: { all: ['not-an-id'] } }, { personIds: { all: [] } }, { takenAt: { gte: 'tomorrow' } }, { isFavorite: { eq: 'true' } }, { rating: { eq: '5' } }, { city: { eq: ['Berlin'] } }, { city: { like: '%' } }, { or: [{ or: [{ city: { eq: 'Berlin' } }] }] }]) {
    assert.throws(() => validateSearch({ mode: 'semantic', filter }), (error: any) => error.status === 400);
  }
  for (const input of [null, { mode: 'other' }, { mode: 'semantic', resultLimit: 1001 }, { mode: 'semantic', resultLimit: 0 }, { mode: 'semantic', queryAssetId: '../private' }, { mode: 'semantic', key: 'private' }]) assert.throws(() => validateSearch(input));
});
