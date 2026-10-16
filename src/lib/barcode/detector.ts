import zxingReaderWasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';
import type { ReadBox } from './camera';

/** Product (EAN/UPC), shelf-label (Code 128) and case (ITF-14) barcodes. QR codes are not products. */
export const RETAIL_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'itf'] as const;

export interface BarcodeRead {
  rawValue: string;
  format: string;
  /** Where the code is in the decoded image. */
  boundingBox?: ReadBox;
}

export type DetectorKind = 'native' | 'wasm';

export interface BarcodeDecoder {
  kind: DetectorKind;
  detect(source: HTMLCanvasElement): Promise<BarcodeRead[]>;
}

/** Native `detect` can hang on some Android builds; never block the frame loop indefinitely. */
export const NATIVE_DECODE_TIMEOUT_MS = 2500;
export const WASM_DECODE_TIMEOUT_MS = 4000;

export function withDecodeTimeout(decoder: BarcodeDecoder, timeoutMs: number): BarcodeDecoder {
  return {
    kind: decoder.kind,
    detect: (source) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      return Promise.race([
        decoder.detect(source),
        new Promise<BarcodeRead[]>((_, reject) => {
          timer = setTimeout(() => reject(new Error('decode_timeout')), timeoutMs);
        }),
      ]).finally(() => {
        if (timer !== undefined) clearTimeout(timer);
      });
    },
  };
}

interface NativeBarcodeDetector {
  detect(source: HTMLCanvasElement): Promise<BarcodeRead[]>;
}

interface NativeBarcodeDetectorClass {
  new (options: { formats: string[] }): NativeBarcodeDetector;
  getSupportedFormats(): Promise<string[]>;
}

/**
 * The browser's own detector (Android Chrome uses Google's ML Kit) is the fastest and most
 * accurate option. Some browsers expose the API without any 1D formats, so EAN-13 is required.
 */
export async function createNativeDecoder(scope: object = globalThis): Promise<BarcodeDecoder | null> {
  const Native = (scope as { BarcodeDetector?: NativeBarcodeDetectorClass }).BarcodeDetector;
  if (typeof Native?.getSupportedFormats !== 'function') return null;
  try {
    const supported = await Native.getSupportedFormats();
    if (!supported.includes('ean_13')) return null;
    const detector = new Native({ formats: RETAIL_FORMATS.filter((f) => supported.includes(f)) });
    return { kind: 'native', detect: (source) => detector.detect(source) };
  } catch {
    return null;
  }
}

/** ZXing C++ compiled to WebAssembly, served from this app (and precached) so it works offline. */
export async function createWasmDecoder(): Promise<BarcodeDecoder> {
  const { BarcodeDetector, prepareZXingModule } = await import('barcode-detector/ponyfill');
  await prepareZXingModule({
    overrides: {
      locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? zxingReaderWasmUrl : prefix + path),
    },
    fireImmediately: true,
  });
  const detector = new BarcodeDetector({ formats: [...RETAIL_FORMATS] });
  return {
    kind: 'wasm',
    detect: async (source) => {
      const ctx = source.getContext('2d', { willReadFrequently: true });
      const image = ctx ? ctx.getImageData(0, 0, source.width, source.height) : source;
      return detector.detect(image);
    },
  };
}

let decoderPromise: Promise<BarcodeDecoder> | null = null;

/** Picks the decoder once per session; a failed WASM load is retried on the next call. */
export function getBarcodeDecoder(): Promise<BarcodeDecoder> {
  if (!decoderPromise) {
    decoderPromise = createNativeDecoder()
      .then((native) => native ?? createWasmDecoder())
      .catch((err: unknown) => {
        decoderPromise = null;
        throw err;
      });
  }
  return decoderPromise;
}
