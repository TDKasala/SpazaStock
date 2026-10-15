import { describe, it, expect } from 'vitest';
import {
  ImageCompressionError,
  MAX_INPUT_BYTES,
  encodeWithinBudget,
  fitWithin,
  validateImageFile,
  type Encoder,
} from '../lib/imageCompression';

function blobOf(size: number, type: string): Blob {
  return new Blob([new Uint8Array(size)], { type });
}

describe('validateImageFile', () => {
  it('accepts common photo formats within the size limit', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/webp', 'image/gif']) {
      expect(validateImageFile({ type, size: 2_000_000 })).toBeNull();
    }
  });

  it('rejects other file types and very large files', () => {
    expect(validateImageFile({ type: 'application/pdf', size: 1000 })).toBe('unsupported');
    expect(validateImageFile({ type: 'image/svg+xml', size: 1000 })).toBe('unsupported');
    expect(validateImageFile({ type: 'image/jpeg', size: MAX_INPUT_BYTES + 1 })).toBe('too_large');
  });
});

describe('fitWithin', () => {
  it('scales the longest side down to 600 and keeps the aspect ratio', () => {
    expect(fitWithin(4000, 3000)).toEqual({ width: 600, height: 450 });
    expect(fitWithin(1080, 1920)).toEqual({ width: 338, height: 600 });
    expect(fitWithin(1200, 1200)).toEqual({ width: 600, height: 600 });
  });

  it('does not enlarge small pictures', () => {
    expect(fitWithin(320, 240)).toEqual({ width: 320, height: 240 });
  });

  it('never returns a zero-size side', () => {
    expect(fitWithin(10000, 2)).toEqual({ width: 600, height: 1 });
  });
});

describe('encodeWithinBudget', () => {
  it('lowers the quality until the picture is 100 KB or less', async () => {
    const qualities: number[] = [];
    const encode: Encoder = async (type, quality) => {
      qualities.push(quality);
      return blobOf(Math.round(quality * 160_000), type);
    };
    const { blob, mimeType } = await encodeWithinBudget(encode);
    expect(mimeType).toBe('image/webp');
    expect(blob.size).toBeLessThanOrEqual(100 * 1024);
    expect(qualities[0]).toBe(0.82);
    expect(qualities.length).toBeGreaterThan(1);
  });

  it('stops at the first quality that fits', async () => {
    const calls: string[] = [];
    const encode: Encoder = async (type, quality) => {
      calls.push(`${type}@${quality}`);
      return blobOf(50_000, type);
    };
    await encodeWithinBudget(encode);
    expect(calls).toEqual(['image/webp@0.82']);
  });

  it('falls back to JPEG when the browser cannot encode WebP', async () => {
    const encode: Encoder = async (type) => (type === 'image/webp' ? blobOf(300_000, 'image/png') : blobOf(80_000, type));
    const { blob, mimeType } = await encodeWithinBudget(encode);
    expect(mimeType).toBe('image/jpeg');
    expect(blob.type).toBe('image/jpeg');
  });

  it('keeps the smallest result when none reach the target but it is still acceptable', async () => {
    const encode: Encoder = async (type, quality) => blobOf(Math.round(150_000 + quality * 10_000), type);
    const { blob } = await encodeWithinBudget(encode);
    expect(blob.size).toBe(155_000);
  });

  it('gives up on pictures that stay too large', async () => {
    const encode: Encoder = async (type) => blobOf(400_000, type);
    await expect(encodeWithinBudget(encode)).rejects.toEqual(new ImageCompressionError('still_too_large'));
  });

  it('reports a failure when nothing can be encoded', async () => {
    const encode: Encoder = async () => null;
    await expect(encodeWithinBudget(encode)).rejects.toMatchObject({ code: 'decode_failed' });
  });
});
