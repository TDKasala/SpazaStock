export type CameraError = 'permission_denied' | 'not_supported' | 'device_not_found' | 'general';

/**
 * Only the centre band of the picture is decoded: barcodes are wide and short, and a smaller
 * image decodes faster and cannot pick up a neighbouring product. The on-screen reticle uses
 * the same fractions so what the user aims at is exactly what is read.
 */
export const SCAN_BAND = { width: 0.85, height: 0.4 } as const;

/** The WASM decoder slows down sharply on large images; EAN bars stay readable at this width. */
export const WASM_MAX_DECODE_WIDTH = 1280;

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

/**
 * The preview uses `object-fit: cover`, which hides part of the video when the view and the
 * camera have different shapes. The band is taken from the visible part so it matches the reticle.
 */
export function scanCrop(
  videoWidth: number,
  videoHeight: number,
  viewWidth: number,
  viewHeight: number,
  maxOutputWidth: number = Number.POSITIVE_INFINITY
): ScanCrop {
  let visibleWidth = videoWidth;
  let visibleHeight = videoHeight;
  if (viewWidth > 0 && viewHeight > 0) {
    const viewAspect = viewWidth / viewHeight;
    if (videoWidth / videoHeight > viewAspect) visibleWidth = videoHeight * viewAspect;
    else visibleHeight = videoWidth / viewAspect;
  }
  const sw = Math.max(1, Math.round(visibleWidth * SCAN_BAND.width));
  const sh = Math.max(1, Math.round(visibleHeight * SCAN_BAND.height));
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
