const videoExtensions = new Set(['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', '3gp', '3g2', 'mts', 'm2ts', 'ts', 'mpg', 'mpeg', 'wmv', 'flv', 'ogv']);
export const mediaExtensions = ['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif', 'tif', 'tiff', 'heic', 'heif', ...videoExtensions];
export const mediaAccept = `image/*,video/*,${mediaExtensions.map(extension => `.${extension}`).join(',')}`;
export function isVideo(name: string) { return videoExtensions.has(name.split('.').pop()?.toLowerCase() || ''); }
