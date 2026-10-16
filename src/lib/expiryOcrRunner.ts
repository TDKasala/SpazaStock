/**
 * On-device OCR for expiry labels via Tesseract.js (lazy-loaded). Photos are never uploaded.
 */

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

const OCR_MAX_EDGE = 2000;
const OCR_MIN_EDGE = 1400;
const INIT_TIMEOUT_MS = 60_000;
const RECOGNIZE_TIMEOUT_MS = 25_000;

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

/** Scales a label photo into the size Tesseract reads well, then boosts contrast. */
export function ocrPixelSize(width: number, height: number): { width: number; height: number } {
  const longEdge = Math.max(width, height);
  let scale = 1;
  if (longEdge > OCR_MAX_EDGE) scale = OCR_MAX_EDGE / longEdge;
  else if (longEdge < OCR_MIN_EDGE) scale = OCR_MIN_EDGE / longEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function boostContrast(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  const image = ctx.getImageData(0, 0, width, height);
  const pixels = image.data;
  for (let i = 0; i < pixels.length; i += 4) {
    const gray = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
    const stretched = Math.max(0, Math.min(255, (gray - 128) * 1.7 + 128));
    pixels[i] = stretched;
    pixels[i + 1] = stretched;
    pixels[i + 2] = stretched;
  }
  ctx.putImageData(image, 0, 0);
}

/** Shrinks or enlarges the label photo and raises contrast so printed dates stay readable. */
export async function prepareOcrImage(file: Blob): Promise<Blob> {
  let source: CanvasImageSource & { width: number; height: number };
  try {
    source = await decodeImage(file);
  } catch {
    throw new ExpiryOcrError('decode');
  }
  if (!source.width || !source.height) throw new ExpiryOcrError('decode');

  const { width, height } = ocrPixelSize(source.width, source.height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new ExpiryOcrError('decode');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  // Downscales look cleaner smoothed. Upscales stay sharp so a small date stamp does not blur.
  ctx.imageSmoothingEnabled = width <= source.width && height <= source.height;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, width, height);
  if ('close' in source && typeof source.close === 'function') source.close();
  boostContrast(ctx, width, height);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
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

type OcrWorker = {
  setParameters: (p: Record<string, string>) => Promise<unknown>;
  recognize: (img: Blob) => Promise<{ data: { text: string } }>;
  terminate: () => Promise<unknown>;
};

/** Kept for the session so the language file is not downloaded again on every photo. */
let workerPromise: Promise<OcrWorker> | null = null;

async function getWorker(): Promise<OcrWorker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker } = await import('tesseract.js');
      const worker = (await createWorker('eng', 1, {
        // Language data is fetched when needed and is not precached (keeps the 3 MB limit).
        logger: () => undefined,
      })) as unknown as OcrWorker;
      await worker.setParameters({
        tessedit_pageseg_mode: '6',
        preserve_interword_spaces: '1',
      });
      return worker;
    })().catch((err) => {
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

async function recognizeWithMode(worker: OcrWorker, image: Blob, mode: string): Promise<string> {
  await worker.setParameters({
    tessedit_pageseg_mode: mode,
    preserve_interword_spaces: '1',
  });
  const { data } = await withTimeout(worker.recognize(image), RECOGNIZE_TIMEOUT_MS);
  return data.text ?? '';
}

/**
 * Reads an expiry label image on the device. Loads Tesseract only when called.
 * Always safe to ignore: callers should fall back to manual date entry on error.
 */
export async function recognizeExpiryDate(file: Blob, today: Date = new Date()): Promise<ExpiryOcrSuccess> {
  const image = await prepareOcrImage(file);
  let worker: OcrWorker | null = null;
  try {
    worker = await withTimeout(getWorker(), INIT_TIMEOUT_MS);
    // A character whitelist makes the LSTM engine return empty text, so it is not set.
    // A block of label text is tried first, then sparse text if no date was found.
    let text = await recognizeWithMode(worker, image, '6');
    let candidates = extractExpiryCandidates(text, today);
    if (candidates.length === 0) {
      const sparse = await recognizeWithMode(worker, image, '11');
      const sparseCandidates = extractExpiryCandidates(sparse, today);
      if (sparseCandidates.length > 0) {
        text = sparse;
        candidates = sparseCandidates;
      } else {
        text = `${text}\n${sparse}`;
        candidates = extractExpiryCandidates(text, today);
      }
    }
    const decision = decideExpirySuggestion(candidates);
    if (decision.kind === 'none' && candidates.length === 0) {
      throw new ExpiryOcrError('no_date');
    }
    return { decision, candidates, text };
  } catch (err) {
    const failedToRead = !(err instanceof ExpiryOcrError) || err.code !== 'no_date';
    if (worker && failedToRead) {
      workerPromise = null;
      try {
        await worker.terminate();
      } catch {
        // The next attempt creates a fresh worker.
      }
    }
    if (err instanceof ExpiryOcrError) throw err;
    throw mapLoadError(err);
  }
}

export type { ExpiryOcrDecision, ExpiryDateCandidate, OcrConfidence };
