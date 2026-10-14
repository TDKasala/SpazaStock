import { describe, it, expect, vi, beforeEach } from 'vitest';
import { expandUpcE, hasValidGtinCheckDigit, validateBarcode } from '../lib/barcode/validate';
import { createReadConfirmer } from '../lib/barcode/confirm';
import { SCAN_BAND, mapCameraError, scanCrop } from '../lib/barcode/camera';
import { RETAIL_FORMATS, createNativeDecoder } from '../lib/barcode/detector';

const ponyfill = vi.hoisted(() => ({
  prepareZXingModule: vi.fn(),
  constructed: [] as unknown[],
}));

vi.mock('barcode-detector/ponyfill', () => ({
  prepareZXingModule: ponyfill.prepareZXingModule,
  BarcodeDetector: class {
    constructor(options: unknown) {
      ponyfill.constructed.push(options);
    }
    detect() {
      return Promise.resolve([]);
    }
  },
}));

describe('barcode validation', () => {
  it('checks the GS1 check digit', () => {
    expect(hasValidGtinCheckDigit('5449000000996')).toBe(true);
    expect(hasValidGtinCheckDigit('5449000000993')).toBe(false);
    expect(hasValidGtinCheckDigit('96385074')).toBe(true);
    expect(hasValidGtinCheckDigit('12a4')).toBe(false);
  });

  it('accepts real EAN-13, EAN-8 and UPC-A codes and rejects misreads', () => {
    expect(validateBarcode('5449000000996', 'ean_13')).toBe('5449000000996');
    expect(validateBarcode('4006381333931', 'ean_13')).toBe('4006381333931');
    expect(validateBarcode('4006381333932', 'ean_13')).toBeNull();
    expect(validateBarcode('400638133393', 'ean_13')).toBeNull();
    expect(validateBarcode('96385074', 'ean_8')).toBe('96385074');
    expect(validateBarcode('96385075', 'ean_8')).toBeNull();
    expect(validateBarcode('036000291452', 'upc_a')).toBe('036000291452');
    expect(validateBarcode('0036000291452', 'upc_a')).toBe('0036000291452');
    expect(validateBarcode('036000291453', 'upc_a')).toBeNull();
  });

  it('validates UPC-E through its UPC-A expansion', () => {
    expect(expandUpcE('01234565')).toBe('012345000065');
    expect(validateBarcode('01234565', 'upc_e')).toBe('01234565');
    expect(validateBarcode('01234566', 'upc_e')).toBeNull();
    expect(validateBarcode('21234565', 'upc_e')).toBeNull();
  });

  it('only accepts ITF as a checked 14-digit case code', () => {
    expect(validateBarcode('00012345600012', 'itf')).toBe('00012345600012');
    expect(validateBarcode('00012345600012', 'itf_14')).toBe('00012345600012');
    expect(validateBarcode('00012345600013', 'itf')).toBeNull();
    expect(validateBarcode('123456', 'itf')).toBeNull();
  });

  it('accepts printable Code 128 of a sensible length', () => {
    expect(validateBarcode('SHELF-0042', 'code_128')).toBe('SHELF-0042');
    expect(validateBarcode('AB', 'code_128')).toBeNull();
    expect(validateBarcode('x'.repeat(49), 'code_128')).toBeNull();
    expect(validateBarcode('AB\u0001CD', 'code_128')).toBeNull();
  });

  it('trims but never rewrites, and ignores formats the shop does not use', () => {
    expect(validateBarcode('  5449000000996\n', 'ean_13')).toBe('5449000000996');
    expect(validateBarcode('   ', 'ean_13')).toBeNull();
    expect(validateBarcode('https://example.com', 'qr_code')).toBeNull();
    expect(validateBarcode('ABC123', 'code_39')).toBeNull();
  });
});

describe('read confirmation', () => {
  it('needs two agreeing reads within the window', () => {
    const confirmer = createReadConfirmer(500, 2);
    expect(confirmer.push('A', 0)).toBe(false);
    expect(confirmer.push('A', 33)).toBe(true);
  });

  it('starts again when a different code or a stale read arrives', () => {
    const confirmer = createReadConfirmer(500, 2);
    expect(confirmer.push('A', 0)).toBe(false);
    expect(confirmer.push('B', 30)).toBe(false);
    expect(confirmer.push('A', 60)).toBe(false);
    expect(confirmer.push('A', 700)).toBe(false);
    expect(confirmer.push('A', 800)).toBe(true);
  });

  it('needs a fresh pair after each confirmation and forgets on reset', () => {
    const confirmer = createReadConfirmer(500, 2);
    confirmer.push('A', 0);
    expect(confirmer.push('A', 30)).toBe(true);
    expect(confirmer.push('A', 60)).toBe(false);
    confirmer.reset();
    expect(confirmer.push('A', 90)).toBe(false);
    expect(confirmer.push('A', 120)).toBe(true);
  });
});

describe('scan crop', () => {
  it('takes the centre band of a frame that fills the view', () => {
    const crop = scanCrop(1600, 1200, 400, 300);
    expect(crop).toEqual({ sx: 120, sy: 360, sw: 1360, sh: 480, width: 1360, height: 480 });
  });

  it('crops from the visible part when object-cover hides the sides', () => {
    // Portrait 1080x1920 video in a 16:9 view shows the full width and the middle 607.5 rows.
    const crop = scanCrop(1080, 1920, 320, 180);
    expect(crop.sw).toBe(Math.round(1080 * SCAN_BAND.width));
    expect(crop.sh).toBe(Math.round(1080 * (180 / 320) * SCAN_BAND.height));
    expect(crop.sx).toBe(Math.round((1080 - crop.sw) / 2));
    expect(crop.sy).toBe(Math.round((1920 - crop.sh) / 2));
  });

  it('downscales the decoder image to the maximum width', () => {
    const crop = scanCrop(3840, 2160, 0, 0, 1280);
    expect(crop.sw).toBe(3264);
    expect(crop.width).toBe(1280);
    expect(crop.height).toBe(Math.round(crop.sh * (1280 / 3264)));
  });
});

describe('camera errors', () => {
  it('maps getUserMedia failures to what the user can do about them', () => {
    expect(mapCameraError(new DOMException('x', 'NotAllowedError'))).toBe('permission_denied');
    expect(mapCameraError(new Error('Permission denied by system'))).toBe('permission_denied');
    expect(mapCameraError(new DOMException('x', 'NotFoundError'))).toBe('device_not_found');
    expect(mapCameraError(new DOMException('x', 'NotSupportedError'))).toBe('not_supported');
    expect(mapCameraError(new DOMException('x', 'NotReadableError'))).toBe('general');
    expect(mapCameraError(null)).toBe('general');
  });
});

describe('decoder selection', () => {
  function nativeScope(supported: string[] | Error) {
    const constructed: unknown[] = [];
    class BarcodeDetector {
      static getSupportedFormats() {
        return supported instanceof Error ? Promise.reject(supported) : Promise.resolve(supported);
      }
      constructor(options: unknown) {
        constructed.push(options);
      }
      detect() {
        return Promise.resolve([{ rawValue: '5449000000996', format: 'ean_13' }]);
      }
    }
    return { scope: { BarcodeDetector }, constructed };
  }

  it('uses the native detector with the retail formats it supports', async () => {
    const { scope, constructed } = nativeScope(['qr_code', 'ean_13', 'ean_8', 'code_128']);
    const decoder = await createNativeDecoder(scope);
    expect(decoder?.kind).toBe('native');
    expect(constructed).toEqual([{ formats: ['ean_13', 'ean_8', 'code_128'] }]);
    await expect(decoder!.detect(document.createElement('canvas'))).resolves.toEqual([
      { rawValue: '5449000000996', format: 'ean_13' },
    ]);
  });

  it('skips a native detector that cannot read EAN-13, fails, or is missing', async () => {
    expect(await createNativeDecoder(nativeScope(['qr_code']).scope)).toBeNull();
    expect(await createNativeDecoder(nativeScope(new Error('no ML Kit')).scope)).toBeNull();
    expect(await createNativeDecoder({})).toBeNull();
  });

  describe('WASM fallback', () => {
    beforeEach(() => {
      vi.resetModules();
      ponyfill.prepareZXingModule.mockReset();
      ponyfill.constructed.length = 0;
    });

    it('loads the self-hosted WASM decoder when there is no native detector', async () => {
      ponyfill.prepareZXingModule.mockResolvedValue({});
      const { getBarcodeDecoder } = await import('../lib/barcode/detector');
      const decoder = await getBarcodeDecoder();
      expect(decoder.kind).toBe('wasm');
      expect(ponyfill.constructed).toEqual([{ formats: [...RETAIL_FORMATS] }]);

      const options = ponyfill.prepareZXingModule.mock.calls[0][0];
      expect(options.fireImmediately).toBe(true);
      const wasmUrl = options.overrides.locateFile('zxing_reader.wasm', 'https://cdn.example/');
      expect(wasmUrl).toMatch(/zxing_reader\.wasm/);
      expect(wasmUrl).not.toContain('cdn.example');
      expect(await getBarcodeDecoder()).toBe(decoder);
    });

    it('retries the WASM load after a failure', async () => {
      ponyfill.prepareZXingModule.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({});
      const { getBarcodeDecoder } = await import('../lib/barcode/detector');
      await expect(getBarcodeDecoder()).rejects.toThrow('offline');
      await expect(getBarcodeDecoder()).resolves.toMatchObject({ kind: 'wasm' });
    });
  });
});
