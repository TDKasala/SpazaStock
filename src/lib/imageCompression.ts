/**
 * Shrinks a product photo on the phone before it is stored or uploaded: at most 600x600, WebP
 * (JPEG where the browser cannot encode WebP), about 100 KB.
 */

export const MAX_IMAGE_DIMENSION = 600;
export const TARGET_IMAGE_BYTES = 100 * 1024;
/** Matches the bucket's file size limit with some headroom (the bucket allows 256 KB). */
export const MAX_IMAGE_BYTES = 250 * 1024;
export const MAX_INPUT_BYTES = 20 * 1024 * 1024;
export const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;

const QUALITIES = [0.82, 0.74, 0.66, 0.58, 0.5];

export type ImageMimeType = 'image/webp' | 'image/jpeg';
export type ImageErrorCode = 'unsupported' | 'too_large' | 'decode_failed' | 'still_too_large';

export class ImageCompressionError extends Error {
  constructor(public readonly code: ImageErrorCode) {
    super(`Image compression failed: ${code}`);
    this.name = 'ImageCompressionError';
  }
}

export interface CompressedImage {
  bytes: ArrayBuffer;
  mimeType: ImageMimeType;
  width: number;
  height: number;
}

export function validateImageFile(file: { type: string; size: number }): ImageErrorCode | null {
  if (!(ACCEPTED_IMAGE_TYPES as readonly string[]).includes(file.type)) return 'unsupported';
  if (file.size > MAX_INPUT_BYTES) return 'too_large';
  return null;
}

/** Scales down to fit inside a `max` square, keeping the aspect ratio. Small images are not enlarged. */
export function fitWithin(width: number, height: number, max = MAX_IMAGE_DIMENSION): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export type Encoder = (mimeType: ImageMimeType, quality: number) => Promise<Blob | null>;

/**
 * Lowers the quality until the picture fits `target`. A browser that cannot encode WebP hands back
 * a PNG instead, so the loop switches to JPEG. The smallest result is kept if none reach the
 * target, as long as it is under `max`.
 */
export async function encodeWithinBudget(
  encode: Encoder,
  target = TARGET_IMAGE_BYTES,
  max = MAX_IMAGE_BYTES
): Promise<{ blob: Blob; mimeType: ImageMimeType }> {
  let smallest: { blob: Blob; mimeType: ImageMimeType } | null = null;
  for (const mimeType of ['image/webp', 'image/jpeg'] as const) {
    let supported = true;
    for (const quality of QUALITIES) {
      const blob = await encode(mimeType, quality);
      if (!blob || blob.type !== mimeType) {
        supported = false;
        break;
      }
      if (!smallest || blob.size < smallest.blob.size) smallest = { blob, mimeType };
      if (blob.size <= target) return { blob, mimeType };
    }
    if (supported) break;
  }
  if (!smallest) throw new ImageCompressionError('decode_failed');
  if (smallest.blob.size > max) throw new ImageCompressionError('still_too_large');
  return smallest;
}

async function decode(file: Blob): Promise<CanvasImageSource & { width: number; height: number }> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      // Fall back to an <img>, which some browsers decode more formats with.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return Object.assign(img, { width: img.naturalWidth, height: img.naturalHeight });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function compressProductImage(file: File): Promise<CompressedImage> {
  const invalid = validateImageFile(file);
  if (invalid) throw new ImageCompressionError(invalid);

  let source: CanvasImageSource & { width: number; height: number };
  try {
    source = await decode(file);
  } catch {
    throw new ImageCompressionError('decode_failed');
  }
  if (!source.width || !source.height) throw new ImageCompressionError('decode_failed');

  const { width, height } = fitWithin(source.width, source.height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new ImageCompressionError('decode_failed');
  // JPEG has no transparency; a white background keeps transparent PNGs readable.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, width, height);
  if ('close' in source && typeof source.close === 'function') source.close();

  const { blob, mimeType } = await encodeWithinBudget(
    (type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality))
  );
  return { bytes: await blob.arrayBuffer(), mimeType, width, height };
}
