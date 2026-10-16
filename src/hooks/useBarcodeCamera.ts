import { useCallback, useEffect, useRef, useState } from 'react';
import { createReadConfirmer } from '../lib/barcode/confirm';
import {
  getBarcodeDecoder,
  NATIVE_DECODE_TIMEOUT_MS,
  WASM_DECODE_TIMEOUT_MS,
  withDecodeTimeout,
  type BarcodeDecoder,
} from '../lib/barcode/detector';
import { validateBarcode } from '../lib/barcode/validate';
import {
  NATIVE_MAX_DECODE_WIDTH,
  SCAN_BAND,
  SCAN_BAND_WIDE,
  WASM_MAX_DECODE_WIDTH,
  WIDE_SCAN_EVERY_N_FRAMES,
  applyTrackEnhancements,
  applyZoomLevel,
  mapCameraError,
  openCameraStream,
  orderByCentre,
  readZoomCapabilities,
  readZoomSetting,
  scanCrop,
  zoomPresetValues,
  type CameraError,
} from '../lib/barcode/camera';

export type CameraStatus = 'idle' | 'starting' | 'scanning' | 'error';

export type ScanHint = 'none' | 'holdSteady' | 'moveCloser' | 'lighting' | 'zoom';

type FrameVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

const SCAN_HINT_DELAY_MS = 2500;
const SCAN_HINT_ROTATE_MS = 3200;

export interface UseBarcodeCameraOptions {
  /** The camera runs only while this is true and stops completely when it turns false. */
  active: boolean;
  /** Called with each validated, confirmed code. */
  onCode: (code: string) => void;
}

/**
 * Rear camera preview plus a decode loop that reads one frame at a time: each decoded frame
 * schedules the next, so a slow phone never builds a queue and the preview stays smooth.
 */
export function useBarcodeCamera({ active, onCode }: UseBarcodeCameraOptions) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const onCodeRef = useRef(onCode);
  onCodeRef.current = onCode;

  const [status, setStatus] = useState<CameraStatus>('idle');
  const [error, setError] = useState<CameraError | null>(null);
  const [hasTorch, setHasTorch] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [zoomSupported, setZoomSupported] = useState(false);
  const [zoomPresets, setZoomPresets] = useState<number[]>([]);
  const [scanHint, setScanHint] = useState<ScanHint>('none');

  useEffect(() => {
    const video = videoRef.current as FrameVideo | null;
    if (!active || !video) {
      setStatus('idle');
      setScanHint('none');
      return;
    }

    let cancelled = false;
    let stream: MediaStream | null = null;
    let frameHandle: number | null = null;
    let usesVideoFrames = false;
    let canvas: HTMLCanvasElement | null = null;
    let ctx: CanvasRenderingContext2D | null = null;
    let decoder: BarcodeDecoder | null = null;
    let frameIndex = 0;
    let lastHintAt = 0;
    let scanningStartedAt = Date.now();
    let hasTorchCapability = false;
    let deviceHasZoom = false;
    let lastPublishedHint: ScanHint = 'none';
    const confirmer = createReadConfirmer();

    const publishHint = (hint: ScanHint) => {
      if (hint === lastPublishedHint) return;
      lastPublishedHint = hint;
      setScanHint(hint);
    };

    setStatus('starting');
    setError(null);
    setHasTorch(false);
    setTorchOn(false);
    setZoomLevel(1);
    setZoomSupported(false);
    setZoomPresets([]);
    publishHint('none');
    scanningStartedAt = Date.now();
    lastHintAt = scanningStartedAt;

    const stopStream = () => {
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
      trackRef.current = null;
      video.srcObject = null;
    };

    const fail = (reason: CameraError) => {
      stopStream();
      setError(reason);
      setStatus('error');
      publishHint('none');
    };

    const updateScanHint = () => {
      const now = Date.now();
      const idleFor = now - lastHintAt;
      if (idleFor < SCAN_HINT_DELAY_MS) {
        publishHint('none');
        return;
      }
      const rotation = Math.floor((idleFor - SCAN_HINT_DELAY_MS) / SCAN_HINT_ROTATE_MS);
      const sequence: ScanHint[] = ['holdSteady', 'moveCloser', 'lighting'];
      if (deviceHasZoom) sequence.push('zoom');
      else if (!hasTorchCapability) sequence.push('zoom');
      publishHint(sequence[rotation % sequence.length] ?? 'holdSteady');
    };

    const decodeFrame = async () => {
      if (!decoder || !canvas || !ctx || document.hidden || video.readyState < 2) return;
      const { videoWidth, videoHeight, clientWidth, clientHeight } = video;
      if (!videoWidth || !videoHeight || !clientWidth || !clientHeight) return;

      frameIndex += 1;
      const useWideBand = frameIndex % WIDE_SCAN_EVERY_N_FRAMES === 0;
      const band = useWideBand ? SCAN_BAND_WIDE : SCAN_BAND;
      const maxWidth = decoder.kind === 'wasm' ? WASM_MAX_DECODE_WIDTH : NATIVE_MAX_DECODE_WIDTH;
      const crop = scanCrop(videoWidth, videoHeight, clientWidth, clientHeight, maxWidth, band);
      if (canvas.width !== crop.width) canvas.width = crop.width;
      if (canvas.height !== crop.height) canvas.height = crop.height;
      ctx.drawImage(video, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, crop.width, crop.height);

      const decodeStarted = performance.now();
      let reads;
      try {
        reads = await decoder.detect(canvas);
      } catch (err) {
        if (import.meta.env.DEV && String((err as Error)?.message) === 'decode_timeout') {
          console.warn('[scanner] decode timed out; continuing frame loop');
        }
        return;
      }
      if (cancelled) return;

      for (const read of orderByCentre(reads, canvas.width, canvas.height)) {
        const code = validateBarcode(read.rawValue, read.format);
        if (!code) continue;
        if (confirmer.push(code)) {
          if (import.meta.env.DEV) {
            performance.mark?.('barcode-scan-confirmed');
            console.debug(
              '[scanner] confirmed',
              code,
              `${Math.round(performance.now() - decodeStarted)}ms frame`,
              `${Math.round(performance.now() - scanningStartedAt)}ms since open`
            );
          }
          lastHintAt = Date.now();
          publishHint('none');
          onCodeRef.current(code);
        } else {
          lastHintAt = Date.now();
        }
        return;
      }

      updateScanHint();
    };

    const scheduleFrame = () => {
      if (cancelled) return;
      if (typeof video.requestVideoFrameCallback === 'function') {
        usesVideoFrames = true;
        frameHandle = video.requestVideoFrameCallback(onFrame);
      } else {
        frameHandle = requestAnimationFrame(onFrame);
      }
    };

    function onFrame() {
      frameHandle = null;
      void decodeFrame().finally(scheduleFrame);
    }

    const onVisibilityChange = () => {
      if (document.hidden) video.pause();
      else if (stream) void video.play().catch(() => undefined);
    };

    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        fail('not_supported');
        return;
      }
      const decoderReady = getBarcodeDecoder();
      decoderReady.catch(() => undefined);
      try {
        stream = await openCameraStream((constraints) => navigator.mediaDevices.getUserMedia(constraints));
        if (cancelled) {
          stopStream();
          return;
        }
        const track = stream.getVideoTracks()[0] ?? null;
        trackRef.current = track;
        if (track) {
          await applyTrackEnhancements(track);
          const zoomCaps = readZoomCapabilities(track);
          deviceHasZoom = zoomCaps.supported;
          setZoomSupported(zoomCaps.supported);
          setZoomPresets(zoomPresetValues(zoomCaps));
          setZoomLevel(readZoomSetting(track));
        }
        const capabilities = track?.getCapabilities?.() ?? {};
        hasTorchCapability = (capabilities as { torch?: boolean }).torch === true;
        setHasTorch(hasTorchCapability);

        video.srcObject = stream;
        await video.play();
        const baseDecoder = await decoderReady;
        if (cancelled) return;
        const timeout =
          baseDecoder.kind === 'wasm' ? WASM_DECODE_TIMEOUT_MS : NATIVE_DECODE_TIMEOUT_MS;
        decoder = withDecodeTimeout(baseDecoder, timeout);

        canvas = document.createElement('canvas');
        ctx = canvas.getContext('2d', { willReadFrequently: decoder.kind === 'wasm', alpha: false });
        scanningStartedAt = Date.now();
        lastHintAt = scanningStartedAt;
        setStatus('scanning');
        scheduleFrame();
      } catch (err) {
        if (!cancelled) fail(mapCameraError(err));
      }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    void start();

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (frameHandle !== null) {
        if (usesVideoFrames) video.cancelVideoFrameCallback?.(frameHandle);
        else cancelAnimationFrame(frameHandle);
      }
      stopStream();
    };
  }, [active, attempt]);

  const reapplyFocus = useCallback(async () => {
    const track = trackRef.current;
    if (!track) return;
    await applyTrackEnhancements(track);
  }, []);

  const toggleTorch = useCallback(async () => {
    const track = trackRef.current;
    if (!track || !hasTorch) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] });
      setTorchOn(next);
      await reapplyFocus();
    } catch (err) {
      console.warn('Torch toggle failed:', err);
    }
  }, [hasTorch, torchOn, reapplyFocus]);

  const setZoom = useCallback(
    async (zoom: number) => {
      const track = trackRef.current;
      if (!track || !zoomSupported) return;
      try {
        await applyZoomLevel(track, zoom);
        setZoomLevel(readZoomSetting(track));
        await reapplyFocus();
      } catch (err) {
        console.warn('Zoom change failed:', err);
      }
    },
    [zoomSupported, reapplyFocus]
  );

  const resetZoom = useCallback(async () => {
    const track = trackRef.current;
    if (!track || !zoomSupported) return;
    const caps = readZoomCapabilities(track);
    try {
      await applyZoomLevel(track, caps.min);
      setZoomLevel(readZoomSetting(track));
      await reapplyFocus();
    } catch (err) {
      console.warn('Zoom reset failed:', err);
    }
  }, [zoomSupported, reapplyFocus]);

  const restart = useCallback(() => setAttempt((n) => n + 1), []);

  return {
    videoRef,
    status,
    error,
    hasTorch,
    torchOn,
    toggleTorch,
    restart,
    zoomLevel,
    zoomSupported,
    zoomPresets,
    setZoom,
    resetZoom,
    scanHint,
  };
}
