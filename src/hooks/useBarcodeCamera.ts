import { useCallback, useEffect, useRef, useState } from 'react';
import { createReadConfirmer } from '../lib/barcode/confirm';
import { getBarcodeDecoder, type BarcodeDecoder } from '../lib/barcode/detector';
import { validateBarcode } from '../lib/barcode/validate';
import {
  CAMERA_CONSTRAINTS,
  WASM_MAX_DECODE_WIDTH,
  mapCameraError,
  orderByCentre,
  scanCrop,
  type CameraError,
} from '../lib/barcode/camera';

export type CameraStatus = 'idle' | 'starting' | 'scanning' | 'error';

interface ExtendedCapabilities extends MediaTrackCapabilities {
  torch?: boolean;
  focusMode?: string[];
}

type FrameVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

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
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const onCodeRef = useRef(onCode);
  onCodeRef.current = onCode;

  const [status, setStatus] = useState<CameraStatus>('idle');
  const [error, setError] = useState<CameraError | null>(null);
  const [hasTorch, setHasTorch] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const video = videoRef.current as FrameVideo | null;
    if (!active || !video) {
      setStatus('idle');
      return;
    }

    let cancelled = false;
    let stream: MediaStream | null = null;
    let frameHandle: number | null = null;
    let usesVideoFrames = false;
    let canvas: HTMLCanvasElement | null = null;
    let ctx: CanvasRenderingContext2D | null = null;
    let decoder: BarcodeDecoder | null = null;
    const confirmer = createReadConfirmer();

    setStatus('starting');
    setError(null);
    setHasTorch(false);
    setTorchOn(false);

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
    };

    const decodeFrame = async () => {
      if (!decoder || !canvas || !ctx || document.hidden || video.readyState < 2) return;
      const { videoWidth, videoHeight } = video;
      if (!videoWidth || !videoHeight) return;
      const crop = scanCrop(
        videoWidth,
        videoHeight,
        video.clientWidth,
        video.clientHeight,
        decoder.kind === 'wasm' ? WASM_MAX_DECODE_WIDTH : undefined
      );
      if (canvas.width !== crop.width) canvas.width = crop.width;
      if (canvas.height !== crop.height) canvas.height = crop.height;
      ctx.drawImage(video, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, crop.width, crop.height);

      let reads;
      try {
        reads = await decoder.detect(canvas);
      } catch {
        return;
      }
      if (cancelled) return;
      for (const read of orderByCentre(reads, canvas.width, canvas.height)) {
        const code = validateBarcode(read.rawValue, read.format);
        if (!code) continue;
        if (confirmer.push(code)) onCodeRef.current(code);
        return;
      }
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
      // Load the decoder while the user answers the camera permission prompt.
      const decoderReady = getBarcodeDecoder();
      decoderReady.catch(() => undefined);
      try {
        stream = await navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS);
        if (cancelled) {
          stopStream();
          return;
        }
        const track = stream.getVideoTracks()[0] ?? null;
        trackRef.current = track;
        const capabilities = (track?.getCapabilities?.() ?? {}) as ExtendedCapabilities;
        if (capabilities.focusMode?.includes('continuous')) {
          await track
            ?.applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] })
            .catch(() => undefined);
        }
        setHasTorch(capabilities.torch === true);

        video.srcObject = stream;
        await video.play();
        decoder = await decoderReady;
        if (cancelled) return;

        canvas = document.createElement('canvas');
        ctx = canvas.getContext('2d', { willReadFrequently: decoder.kind === 'wasm', alpha: false });
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

  const toggleTorch = useCallback(async () => {
    const track = trackRef.current;
    if (!track || !hasTorch) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] });
      setTorchOn(next);
    } catch (err) {
      console.warn('Torch toggle failed:', err);
    }
  }, [hasTorch, torchOn]);

  const restart = useCallback(() => setAttempt((n) => n + 1), []);

  return { videoRef, status, error, hasTorch, torchOn, toggleTorch, restart };
}
