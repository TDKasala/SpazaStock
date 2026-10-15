/**
 * On-device OCR for expiry labels via Tesseract.js (lazy-loaded). Photos are never uploaded.
 */

import { fitWithin } from './imageCompression';
import {
  decideExpirySuggestion,
  extractExpiryCandidates,
  type ExpiryDateCandidate,
  type ExpiryOcrDecision,
  type OcrConfidence,
} from './expiryOcr';

export type ExpiryOcrErrorCode =
  | 'permission'
  | 'camera'
  | 'decode'
  | 'timeout'
  | 'no_date'
  | 'unavailable';

export class ExpiryOcrError extends Error {
  constructor(public readonly code: ExpiryOcrErrorCode) {
    super(`Expiry OCR failed: ${code}`);
    this.name = 'ExpiryOcrError';
  }
}

export interface ExpiryOcrSuccess {
  decision: ExpiryOcrDecision;
  candidates: ExpiryDateCandidate[];
  text: string;
}

const OCR_MAX_EDGE = 1280;
const OCR_TIMEOUT_MS = 12_000;
const CHAR_WHITELIST = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz/.-: ';

async function decodeImage(file: Blob): Promise<CanvasImageSource & { width: number; height: number }> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      // Fall through to <img>.
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

/** Shrinks the label photo for faster mobile OCR; returns a JPEG blob. */
export async function prepareOcrImage(file: Blob): Promise<Blob> {
  let source: CanvasImageSource & { width: number; height: number };
  try {
    source = await decodeImage(file);
  } catch {
    throw new ExpiryOcrError('decode');
  }
  if (!source.width || !source.height) throw new ExpiryOcrError('decode');

  const { width, height } = fitWithin(source.width, source.height, OCR_MAX_EDGE);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new ExpiryOcrError('decode');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, width, height);
  if ('close' in source && typeof source.close === 'function') source.close();

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  if (!blob) throw new ExpiryOcrError('decode');
  return blob;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new ExpiryOcrError('timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function mapLoadError(err: unknown): ExpiryOcrError {
  if (err instanceof ExpiryOcrError) return err;
  const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  if (message.includes('permission') || message.includes('notallowed')) return new ExpiryOcrError('permission');
  if (message.includes('camera') || message.includes('getusermedia')) return new ExpiryOcrError('camera');
  if (message.includes('abort') || message.includes('timeout')) return new ExpiryOcrError('timeout');
  return new ExpiryOcrError('unavailable');
}

/**
 * Reads an expiry label image on the device. Loads Tesseract only when called.
 * Always safe to ignore: callers should fall back to manual date entry on error.
 */
export async function recognizeExpiryDate(file: Blob, today: Date = new Date()): Promise<ExpiryOcrSuccess> {
  const image = await prepareOcrImage(file);

  type OcrWorker = {
    setParameters: (p: Record<string, string>) => Promise<unknown>;
    recognize: (img: Blob) => Promise<{ data: { text: string } }>;
    terminate: () => Promise<unknown>;
  };

  let worker: OcrWorker | null = null;
  try {
    const { createWorker } = await import('tesseract.js');
    worker = (await withTimeout(
      createWorker('eng', 1, {
        // CDN lang/worker — not precached by the service worker (keeps the 3 MB limit).
        logger: () => undefined,
      }),
      OCR_TIMEOUT_MS
    )) as unknown as OcrWorker;

    await worker.setParameters({
      tessedit_char_whitelist: CHAR_WHITELIST,
      preserve_interword_spaces: '1',
    });

    const { data } = await withTimeout(worker.recognize(image), OCR_TIMEOUT_MS);
    const text = data.text ?? '';
    const candidates = extractExpiryCandidates(text, today);
    const decision = decideExpirySuggestion(candidates);
    if (decision.kind === 'none' && candidates.length === 0) {
      throw new ExpiryOcrError('no_date');
    }
    return { decision, candidates, text };
  } catch (err) {
    if (err instanceof ExpiryOcrError) throw err;
    throw mapLoadError(err);
  } finally {
    try {
      await worker?.terminate();
    } catch {
      // Ignore terminate failures.
    }
  }
}

export type { ExpiryOcrDecision, ExpiryDateCandidate, OcrConfidence };
