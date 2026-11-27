import type { Photo } from '../types';

export const thumbnailSource = (photo: Photo) => photo.restoredUrl ? 'restored' as const : 'original' as const;
export const displaySource = (photo: Photo) => photo.restoredUrl || photo.originalUrl;
export const hasThumbnail = (photo: Photo) => Boolean(photo.thumbnailUrl && photo.thumbnailSource === thumbnailSource(photo));

// Preserve the full frame and its orientation; cards apply their existing object-cover crop.
export async function createThumbnail(source: string): Promise<string> {
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.src = source;
  await image.decode();
  const scale = Math.min(1, 640 / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  try {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Thumbnail generation is unavailable.');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const result = canvas.toDataURL('image/webp', 0.78);
    if (!result.startsWith('data:image/')) throw new Error('Could not encode thumbnail.');
    return result;
  } finally {
    canvas.width = canvas.height = 0;
    image.src = '';
  }
}
