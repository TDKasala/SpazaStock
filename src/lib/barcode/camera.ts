export type CameraError = 'permission_denied' | 'not_supported' | 'device_not_found' | 'general';

/**
 * Only the centre band of the picture is decoded: barcodes are wide and short, and a smaller
 * image decodes faster and cannot pick up a neighbouring product. The on-screen reticle uses
 * the same fractions so what the user aims at is exactly what is read.
 */
export const SCAN_BAND = { width: 0.9, height: 0.5 } as const;

/** Wider band used on occasional frames so small or off-centre codes are not missed. */
export const SCAN_BAND_WIDE = { width: 0.95, height: 0.65 } as const;

/** Every Nth decode pass uses {@link SCAN_BAND_WIDE}. */
export const WIDE_SCAN_EVERY_N_FRAMES = 8;

/** The WASM decoder slows down sharply on large images; EAN bars stay readable at this width. */
export const WASM_MAX_DECODE_WIDTH = 1440;

/** Native BarcodeDetector (ML Kit on Android) can use more pixels without the same WASM cost. */
export const NATIVE_MAX_DECODE_WIDTH = 1920;

/**
 * 1080p gives thin EAN bars enough pixels; 30 fps keeps the preview smooth. Values are `ideal`
 * so phones that cannot match them still open the camera.
 */
export const CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  audio: false,
  video: {
    facingMode: { ideal: 'environment' },
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    frameRate: { ideal: 30 },
  },
};

/**
 * Tries the highest practical resolution first, then steps down when the device cannot satisfy it.
 * 1080p is attempted before 4K: on many Android phones a 4K capture mode uses fixed focus or
 * slow AF in preview, while 1080p keeps continuous autofocus reliable for barcode scanning.
 */
export const CAMERA_OPEN_ATTEMPTS: MediaStreamConstraints[] = [
  CAMERA_CONSTRAINTS,
  {
    audio: false,
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 3840 },
      height: { ideal: 2160 },
      frameRate: { ideal: 30 },
    },
  },
  {
    audio: false,
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
    },
  },
  {
    audio: false,
    video: { facingMode: { ideal: 'environment' } },
  },
];

export interface ScanCrop {
  /** Source rectangle in video pixels. */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** Size of the image handed to the decoder. */
  width: number;
  height: number;
}

export interface ScanBand {
  width: number;
  height: number;
}

/**
 * The preview uses `object-fit: cover`, which hides part of the video when the view and the
 * camera have different shapes. The band is taken from the visible part so it matches the reticle.
 */
export function scanCrop(
  videoWidth: number,
  videoHeight: number,
  viewWidth: number,
  viewHeight: number,
  maxOutputWidth: number = Number.POSITIVE_INFINITY,
  band: ScanBand = SCAN_BAND
): ScanCrop {
  let visibleWidth = videoWidth;
  let visibleHeight = videoHeight;
  if (viewWidth > 0 && viewHeight > 0) {
    const viewAspect = viewWidth / viewHeight;
    if (videoWidth / videoHeight > viewAspect) visibleWidth = videoHeight * viewAspect;
    else visibleHeight = videoWidth / viewAspect;
  }
  const sw = Math.max(1, Math.round(visibleWidth * band.width));
  const sh = Math.max(1, Math.round(visibleHeight * band.height));
  const scale = Math.min(1, maxOutputWidth / sw);
  return {
    sx: Math.round((videoWidth - sw) / 2),
    sy: Math.round((videoHeight - sh) / 2),
    sw,
    sh,
    width: Math.max(1, Math.round(sw * scale)),
    height: Math.max(1, Math.round(sh * scale)),
  };
}

export interface ReadBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The band is large enough to hold two products' barcodes at once. Reading the one nearest the
 * centre of the frame (what the user is aiming at) first keeps consecutive frames agreeing on the
 * same code instead of flipping between neighbours. Reads without a box keep their order, last.
 */
export function orderByCentre<T extends { boundingBox?: ReadBox }>(
  reads: readonly T[],
  width: number,
  height: number
): T[] {
  const cx = width / 2;
  const cy = height / 2;
  const distance = (read: T) => {
    const box = read.boundingBox;
    if (!box) return Number.POSITIVE_INFINITY;
    const dx = box.x + box.width / 2 - cx;
    const dy = box.y + box.height / 2 - cy;
    return dx * dx + dy * dy;
  };
  return reads
    .map((read, index) => ({ read, index, distance: distance(read) }))
    .sort((a, b) => (a.distance === b.distance ? a.index - b.index : a.distance - b.distance))
    .map((entry) => entry.read);
}

export function mapCameraError(err: unknown): CameraError {
  const name = (err as { name?: unknown } | null)?.name;
  const message = String((err as { message?: unknown } | null)?.message ?? '').toLowerCase();
  if (
    name === 'NotAllowedError' ||
    name === 'PermissionDeniedError' ||
    message.includes('permission') ||
    message.includes('denied')
  ) {
    return 'permission_denied';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
    return 'device_not_found';
  }
  if (name === 'NotSupportedError') return 'not_supported';
  return 'general';
}

export interface ExtendedTrackCapabilities extends MediaTrackCapabilities {
  torch?: boolean;
  focusMode?: string[];
  exposureMode?: string[];
  zoom?: { min: number; max: number; step?: number };
}

export interface ZoomCapabilities {
  supported: boolean;
  min: number;
  max: number;
  step: number;
}

export function readZoomCapabilities(track: MediaStreamTrack | null): ZoomCapabilities {
  const caps = (track?.getCapabilities?.() ?? {}) as ExtendedTrackCapabilities;
  const zoom = caps.zoom;
  if (zoom && typeof zoom.min === 'number' && typeof zoom.max === 'number') {
    return { supported: true, min: zoom.min, max: zoom.max, step: zoom.step ?? 0.1 };
  }
  return { supported: false, min: 1, max: 1, step: 0.1 };
}

export function readZoomSetting(track: MediaStreamTrack | null): number {
  const zoom = (track?.getSettings?.() as { zoom?: number } | undefined)?.zoom;
  return typeof zoom === 'number' && Number.isFinite(zoom) ? zoom : 1;
}

/** Preset zoom factors clamped to what the device reports. */
export function zoomPresetValues(caps: ZoomCapabilities): number[] {
  if (!caps.supported) return [];
  const candidates = [1, 1.5, 2, 2.5, 3];
  return candidates.filter((value) => value >= caps.min - 0.05 && value <= caps.max + 0.05);
}

export function clampZoom(caps: ZoomCapabilities, zoom: number): number {
  if (!caps.supported) return 1;
  const stepped =
    caps.step > 0 ? Math.round(zoom / caps.step) * caps.step : zoom;
  return Math.min(caps.max, Math.max(caps.min, stepped));
}

async function applyConstraint(
  track: MediaStreamTrack,
  direct: MediaTrackConstraints,
  advanced: MediaTrackConstraintSet
): Promise<void> {
  await track.applyConstraints(direct).catch(() => track.applyConstraints({ advanced: [advanced] }).catch(() => undefined));
}

/**
 * Requests continuous autofocus and exposure as separate operations. Never combine them in one
 * `advanced` array: browsers OR those entries, so exposure can apply without focus.
 */
export async function applyTrackEnhancements(track: MediaStreamTrack): Promise<void> {
  const caps = (track.getCapabilities?.() ?? {}) as ExtendedTrackCapabilities;
  if (caps.focusMode?.includes('continuous')) {
    await applyConstraint(
      track,
      { focusMode: 'continuous' } as MediaTrackConstraints,
      { focusMode: 'continuous' } as MediaTrackConstraintSet
    );
  }
  if (caps.exposureMode?.includes('continuous')) {
    await applyConstraint(
      track,
      { exposureMode: 'continuous' } as MediaTrackConstraints,
      { exposureMode: 'continuous' } as MediaTrackConstraintSet
    );
  }
}

export async function applyZoomLevel(track: MediaStreamTrack, zoom: number): Promise<void> {
  const caps = readZoomCapabilities(track);
  if (!caps.supported) return;
  const clamped = clampZoom(caps, zoom);
  await track.applyConstraints({ advanced: [{ zoom: clamped } as MediaTrackConstraintSet] });
}

/**
 * Opens the rear camera at the highest resolution the device will grant, without failing when
 * 4K or 1080p is unavailable.
 */
export async function openCameraStream(
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>
): Promise<MediaStream> {
  let lastError: unknown;
  for (const constraints of CAMERA_OPEN_ATTEMPTS) {
    try {
      return await getUserMedia(constraints);
    } catch (err) {
      lastError = err;
      if (mapCameraError(err) === 'permission_denied') throw err;
    }
  }
  throw lastError ?? new Error('Could not open camera');
}
