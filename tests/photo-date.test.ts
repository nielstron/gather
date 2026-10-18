import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filenameCaptureDate, photoDate, photoTimestamp } from '../src/lib/photo-date';
test('camera filenames provide validated fallback dates, without inventing dates for other names', () => {
  assert.equal(filenameCaptureDate('PXL_20261012_224438827.MP.jpg'), '2026-10-12T22:44:38.827Z');
  assert.equal(filenameCaptureDate('IMG_20261012_224438.jpg'), '2026-10-12T22:44:38.000Z');
  for (const name of ['PXL_20260230_120000000.jpg', 'PXL_20261012_254438827.jpg', 'IMG_1234.jpg']) assert.equal(filenameCaptureDate(name), undefined);
  assert.equal(photoDate({ name: 'PXL_20261012_224438827.jpg', modifiedAt: '2026-10-18', takenAt: '2026-10-12T15:44:38.827' } as any), '2026-10-12T15:44:38.827');
});

test('camera-local sorting does not depend on the server or browser timezone', () => {
  const timezone = process.env.TZ;
  try {
    const photo = { name: 'camera.jpg', takenAt: '2026-10-12T15:44:38.827', modifiedAt: '2026-10-18T00:00:00Z' } as any;
    process.env.TZ = 'UTC'; const utc = photoTimestamp(photo);
    process.env.TZ = 'America/Los_Angeles'; assert.equal(photoTimestamp(photo), utc);
  } finally { if (timezone === undefined) delete process.env.TZ; else process.env.TZ = timezone; }
});
