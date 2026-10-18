import type { Photo } from './types';

/** A filename is a fallback for photos whose camera metadata is not indexed yet. */
export function filenameCaptureDate(name: string): string | undefined {
  const match = /^(?:PXL_|IMG_)(\d{4})(\d{2})(\d{2})[_-](\d{2})(\d{2})(\d{2})(\d{3})?(?:[._-]|$)/i.exec(name);
  if (!match) return;
  const [, year, month, day, hour, minute, second, milliseconds = '000'] = match;
  const value = `${year}-${month}-${day}T${hour}:${minute}:${second}.${milliseconds}Z`;
  const date = new Date(value);
  if (Number.isFinite(date.getTime()) && date.toISOString() === value) return value;
}
export function photoDate(photo: Photo): string { return photo.takenAt || filenameCaptureDate(photo.name) || photo.modifiedAt; }

/** Camera-local timestamps sort identically on the server and in any viewer timezone. */
export function photoTimestamp(photo: Photo): number {
  const value = photoDate(photo);
  return Date.parse(value.includes('T') && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? `${value}Z` : value);
}
