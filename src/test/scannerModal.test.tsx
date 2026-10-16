import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BarcodeScannerModal, type BarcodeScannerModalProps } from '../components/scanner/BarcodeScannerModal';
import { LanguageProvider } from '../context/LanguageContext';
import { SCAN_BAND } from '../lib/barcode/camera';
import { en } from '../locales/en';

const decoder = vi.hoisted(() => ({
  kind: 'native' as const,
  detect: vi.fn(),
}));

vi.mock('../lib/barcode/detector', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/barcode/detector')>();
  return {
    ...actual,
    getBarcodeDecoder: () => Promise.resolve(decoder),
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface FakeTrack {
  stop: ReturnType<typeof vi.fn>;
  getCapabilities: () => object;
  applyConstraints: () => Promise<void>;
}

let container: HTMLDivElement;
let root: Root;
let tracks: FakeTrack[];
let getUserMedia: ReturnType<typeof vi.fn>;

function fakeStream() {
  const track: FakeTrack = { stop: vi.fn(), getCapabilities: () => ({}), applyConstraints: () => Promise.resolve() };
  tracks.push(track);
  // The video element only accepts a real MediaStream.
  return Object.assign(new MediaStream(), { getTracks: () => [track], getVideoTracks: () => [track] });
}

function setMediaDevices(value: unknown) {
  Object.defineProperty(navigator, 'mediaDevices', { value, configurable: true });
}

function setVisualViewport(value: unknown) {
  Object.defineProperty(window, 'visualViewport', { value, configurable: true });
}

const baseProps: BarcodeScannerModalProps = {
  isOpen: true,
  onClose: () => undefined,
  onBarcodeScanned: () => undefined,
};

async function render(props: Partial<BarcodeScannerModalProps> = {}) {
  await act(async () => {
    root.render(
      <LanguageProvider>
        <BarcodeScannerModal {...baseProps} {...props} />
      </LanguageProvider>
    );
  });
  await flush();
}

async function flush(ms = 0) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

const query = (testId: string) => container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const buttonNamed = (name: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === name || b.getAttribute('aria-label') === name);

async function click(el: Element | undefined | null) {
  expect(el).toBeTruthy();
  await act(async () => {
    (el as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flush();
}

async function typeInto(input: HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  localStorage.clear();
  tracks = [];
  getUserMedia = vi.fn(() => Promise.resolve(fakeStream()));
  setMediaDevices({ getUserMedia });
  setVisualViewport(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  decoder.detect.mockReset();
  decoder.detect.mockResolvedValue([]);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  document.body.style.overflow = '';
});

describe('barcode scanner layout', () => {
  it('renders one video with the aim frame sized to the decoded band', async () => {
    await render();
    expect(container.querySelectorAll('video')).toHaveLength(1);
    const frame = query('scanner-frame')!;
    expect(frame.style.width).toBe(`${SCAN_BAND.width * 100}%`);
    expect(frame.style.height).toBe(`${SCAN_BAND.height * 100}%`);
    // The frame and the video share the viewfinder box the decoder measures.
    const viewfinder = query('scanner-viewfinder')!;
    expect(viewfinder.contains(frame)).toBe(true);
    expect(viewfinder.contains(container.querySelector('video'))).toBe(true);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).not.toContain(en.scanner.connecting);
  });

  it('pins the footer outside the scrolling area and keeps feedback in it', async () => {
    await render({
      continuous: true,
      children: <p data-testid="feedback">sold</p>,
      footer: <span data-testid="totals">totals</span>,
    });
    const scroll = query('scanner-scroll')!;
    const footer = query('scanner-footer')!;
    expect(scroll.contains(query('feedback'))).toBe(true);
    expect(footer.contains(query('totals'))).toBe(true);
    expect(scroll.contains(footer)).toBe(false);
    expect(query('scanner-viewfinder')!.contains(footer)).toBe(false);
  });

  it('locks page scrolling while open and closes on Escape', async () => {
    const onClose = vi.fn();
    await render({ onClose });
    expect(document.body.style.overflow).toBe('hidden');
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    await render({ onClose, isOpen: false });
    expect(document.body.style.overflow).toBe('');
  });

  it('fits the visible viewport so the keyboard never covers it', async () => {
    const vv = Object.assign(new EventTarget(), { height: 780, offsetTop: 0 });
    setVisualViewport(vv);
    await render();
    const overlay = query('scanner-overlay')!;
    expect(overlay.style.height).toBe('780px');

    // Android keyboard opens: the visible area shrinks.
    await act(async () => {
      vv.height = 420;
      vv.dispatchEvent(new Event('resize'));
    });
    expect(overlay.style.height).toBe('420px');
    expect(overlay.style.top).toBe('0px');
  });
});

describe('barcode scanner camera lifecycle', () => {
  it('stops the camera when the scanner closes', async () => {
    await render();
    expect(tracks).toHaveLength(1);
    await render({ isOpen: false });
    expect(tracks[0].stop).toHaveBeenCalled();
    expect(query('scanner-overlay')).toBeNull();
  });

  it('stops the camera when the scanner unmounts', async () => {
    await render();
    await act(async () => root.unmount());
    expect(tracks[0].stop).toHaveBeenCalled();
    root = createRoot(container);
  });

  it('stops the camera on Manual Entry and restarts it on Camera Scanner', async () => {
    await render();
    await click(buttonNamed(en.scanner.manualTab));
    expect(tracks[0].stop).toHaveBeenCalled();
    expect(container.querySelector('video')).toBeNull();
    expect(container.querySelector('input')).not.toBeNull();

    await click(buttonNamed(en.scanner.cameraTab));
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(container.querySelectorAll('video')).toHaveLength(1);
  });

  it('explains a denied permission and offers retry and manual entry', async () => {
    getUserMedia.mockRejectedValueOnce(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }));
    await render();
    const alert = container.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain(en.scanner.permissionDeniedTitle);

    await click(buttonNamed(en.scanner.retryCamera));
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();

    getUserMedia.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
    await click(buttonNamed(en.scanner.manualTab));
    await click(buttonNamed(en.scanner.cameraTab));
    await click(
      [...container.querySelectorAll('[role="alert"] button')].find((b) => b.textContent?.includes(en.scanner.manualTab))
    );
    expect(container.querySelector('input')).not.toBeNull();
  });

  it('falls back to manual entry when the browser has no camera API', async () => {
    setMediaDevices(undefined);
    await render();
    expect(container.querySelector('video')).toBeNull();
    expect(container.querySelector('input')).not.toBeNull();
  });
});

describe('barcode scanner input', () => {
  it('sells every deliberate manual entry and stays open while rapid selling', async () => {
    const onBarcodeScanned = vi.fn();
    await render({ continuous: true, onBarcodeScanned });
    await click(buttonNamed(en.scanner.manualTab));
    const input = container.querySelector('input')!;
    expect(input.getAttribute('enterkeyhint')).toBe('go');

    for (let i = 0; i < 2; i++) {
      await typeInto(input, ' 5449000000996 ');
      await click(buttonNamed(en.scanner.submitBarcode));
    }
    expect(onBarcodeScanned.mock.calls).toEqual([['5449000000996'], ['5449000000996']]);
    expect(query('scanner-overlay')).not.toBeNull();
    expect(container.querySelector('input')!.value).toBe('');
  });

  it('rejects an empty manual entry', async () => {
    const onBarcodeScanned = vi.fn();
    await render({ onBarcodeScanned });
    await click(buttonNamed(en.scanner.manualTab));
    await click(buttonNamed(en.scanner.submitBarcode));
    expect(onBarcodeScanned).not.toHaveBeenCalled();
    expect(container.textContent).toContain(en.scanner.invalidBarcode);
  });

  it('sells a product held in frame once, choosing the code nearest the centre', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: () => undefined,
    } as unknown as CanvasRenderingContext2D);
    // An off-centre neighbour is listed first; the aimed-at product is in the middle.
    decoder.detect.mockImplementation((canvas: HTMLCanvasElement) =>
      Promise.resolve([
        { rawValue: '96385074', format: 'ean_8', boundingBox: { x: 0, y: 0, width: 40, height: 10 } },
        {
          rawValue: '5449000000996',
          format: 'ean_13',
          boundingBox: { x: canvas.width / 2 - 50, y: canvas.height / 2 - 10, width: 100, height: 20 },
        },
      ])
    );
    const onBarcodeScanned = vi.fn();
    await render({ continuous: true, onBarcodeScanned });
    const video = container.querySelector('video')!;
    Object.defineProperties(video, {
      readyState: { value: 4 },
      videoWidth: { value: 1920 },
      videoHeight: { value: 1080 },
      clientWidth: { value: 390 },
      clientHeight: { value: 330 },
    });

    // Many frames of the same item in view.
    await flush(400);
    expect(decoder.detect.mock.calls.length).toBeGreaterThan(4);
    expect(onBarcodeScanned.mock.calls).toEqual([['5449000000996']]);
  });
});
