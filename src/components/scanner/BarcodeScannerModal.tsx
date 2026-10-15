import React, { useEffect, useRef, useState } from 'react';
import {
  Camera,
  Keyboard,
  X,
  Flashlight,
  FlashlightOff,
  AlertTriangle,
  RotateCcw,
  Sparkles,
  Search,
} from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { createScanGate } from '../../lib/scanGate';
import { SCAN_BAND } from '../../lib/barcode/camera';
import { playScanBeep, vibrateScan } from '../../lib/barcode/feedback';
import { useBarcodeCamera } from '../../hooks/useBarcodeCamera';
import { useVisualViewport } from '../../hooks/useVisualViewport';

export interface BarcodeScannerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onBarcodeScanned: (barcode: string) => void;
  title?: string;
  /** Keep the camera running and report every new scan (rapid selling). */
  continuous?: boolean;
  /** Rendered under the viewfinder, e.g. live sale feedback in continuous mode. */
  children?: React.ReactNode;
  /** Pinned to the bottom edge, outside the scrolling area, e.g. session totals and Done. */
  footer?: React.ReactNode;
}

type ScannerViewMode = 'camera' | 'manual';

/** A camera re-reading the same code right after reopening must not record a second action. */
const DUPLICATE_SCAN_WINDOW_MS = 1500;

/** Lets the keyboard finish opening before the focused field is scrolled into view. */
const KEYBOARD_SETTLE_MS = 300;

const SAMPLE_BARCODES = [
  { code: '6001007300123', label: 'Albany White Bread' },
  { code: '5449000000996', label: 'Coca-Cola 330ml Can' },
  { code: '6001087361250', label: 'Simba Chips Smoked Beef' },
  { code: '6001062000549', label: 'Sunlight Dishwashing 750ml' },
];

/**
 * Full screen on phones (portrait, and split into two columns in landscape); a centred card on
 * tablets and desktops (the `modal:` variant). There is a single `<video>` for every layout so
 * the camera hook never loses its element when the screen rotates.
 */
export const BarcodeScannerModal: React.FC<BarcodeScannerModalProps> = ({
  isOpen,
  onClose,
  onBarcodeScanned,
  title,
  continuous = false,
  children,
  footer,
}) => {
  const { t } = useLanguage();
  const [viewMode, setViewMode] = useState<ScannerViewMode>('camera');
  const [manualInput, setManualInput] = useState('');
  const [manualError, setManualError] = useState('');
  /** A single-scan session stops the camera as soon as it has its code. */
  const [captured, setCaptured] = useState(false);
  const viewport = useVisualViewport(isOpen);

  const lastCameraScanRef = useRef<{ code: string; at: number } | null>(null);
  const scanGateRef = useRef(createScanGate());
  // The camera callback outlives renders; always report to the latest handler and mode.
  const onScannedRef = useRef(onBarcodeScanned);
  onScannedRef.current = onBarcodeScanned;
  const continuousRef = useRef(continuous);
  continuousRef.current = continuous;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    scanGateRef.current.reset();
    setCaptured(false);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen]);

  const handleCameraCode = (code: string) => {
    if (continuousRef.current) {
      if (!scanGateRef.current.accept(code)) return;
      playScanBeep();
      vibrateScan(50);
      onScannedRef.current(code);
      return;
    }
    const now = Date.now();
    const last = lastCameraScanRef.current;
    if (last && last.code === code && now - last.at < DUPLICATE_SCAN_WINDOW_MS) return;
    lastCameraScanRef.current = { code, at: now };
    setCaptured(true);
    playScanBeep();
    vibrateScan([70, 40, 70]);
    onScannedRef.current(code);
  };

  const camera = useBarcodeCamera({
    active: isOpen && viewMode === 'camera' && !captured,
    onCode: handleCameraCode,
  });
  const cameraError = camera.error;

  useEffect(() => {
    if (cameraError === 'not_supported') setViewMode('manual');
  }, [cameraError]);

  const handleManualSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const clean = manualInput.trim();
    if (!clean) {
      setManualError(t('scanner.invalidBarcode'));
      return;
    }
    setManualInput('');
    submitCode(clean);
  };

  const handleSampleBarcode = (sampleCode: string) => submitCode(sampleCode);

  /** Typed codes are deliberate, so they skip the camera's presence gate. */
  const submitCode = (code: string) => {
    if (!continuous) setCaptured(true);
    onBarcodeScanned(code);
  };

  const handleManualFocus = (e: React.FocusEvent<HTMLInputElement>) => {
    const field = e.currentTarget;
    window.setTimeout(() => field.scrollIntoView?.({ block: 'nearest' }), KEYBOARD_SETTLE_MS);
  };

  if (!isOpen) return null;

  const isCamera = viewMode === 'camera';
  const overlayStyle: React.CSSProperties | undefined = viewport
    ? { top: viewport.offsetTop, height: viewport.height, bottom: 'auto' }
    : undefined;

  const tabClass = (active: boolean) =>
    `flex items-center justify-center gap-2 min-h-[40px] text-xs font-semibold rounded-lg transition-colors ${
      active ? 'bg-emerald-600 text-white shadow-sm' : 'text-zinc-400 hover:text-zinc-200'
    }`;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="scanner-title"
      data-testid="scanner-overlay"
      style={overlayStyle}
      className="fixed inset-0 z-50 flex justify-center bg-black modal:items-center modal:p-4 modal:bg-black/85 modal:backdrop-blur-md animate-in fade-in duration-200"
    >
      <div className="relative w-full h-full flex flex-col overflow-hidden bg-black pl-[env(safe-area-inset-left,0px)] pr-[env(safe-area-inset-right,0px)] modal:h-auto modal:max-h-[min(100%,860px)] modal:max-w-lg md:modal:max-w-xl modal:px-0 modal:bg-zinc-950 modal:border modal:border-zinc-800 modal:rounded-3xl modal:shadow-2xl">
        {/* Header */}
        <div className="shrink-0 flex items-center justify-between gap-3 px-4 pb-2 pt-[max(0.5rem,env(safe-area-inset-top,0px))] modal:px-5 modal:py-3 border-b border-zinc-800/80 bg-zinc-950 modal:bg-zinc-900/60">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-8 h-8 shrink-0 rounded-lg bg-emerald-500/20 text-emerald-400 flex items-center justify-center border border-emerald-500/30">
              <Camera className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h3 id="scanner-title" className="text-sm font-bold text-zinc-100 truncate">
                {title || t('scanner.title')}
              </h3>
              <p className="text-[11px] text-zinc-400 leading-tight mt-0.5 truncate">
                {isCamera ? t('scanner.instruction') : t('scanner.manualEntryTitle')}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-11 h-11 shrink-0 -mr-2 flex items-center justify-center text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 rounded-xl transition-colors"
            aria-label={t('common.close')}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className={`flex-1 min-h-0 flex flex-col ${isCamera ? 'scanner-split' : ''}`}>
          <div className="scanner-media shrink-0 flex flex-col">
            {/* Camera / Manual switch */}
            <div className="shrink-0 grid grid-cols-2 gap-1 p-1 mx-3 my-2 modal:mx-4 modal:my-3 bg-zinc-900/90 rounded-xl border border-zinc-800">
              <button
                type="button"
                aria-pressed={isCamera}
                onClick={() => setViewMode('camera')}
                className={tabClass(isCamera)}
              >
                <Camera className="w-4 h-4" />
                <span>{t('scanner.cameraTab')}</span>
              </button>
              <button
                type="button"
                aria-pressed={!isCamera}
                onClick={() => setViewMode('manual')}
                className={tabClass(!isCamera)}
              >
                <Keyboard className="w-4 h-4" />
                <span>{t('scanner.manualTab')}</span>
              </button>
            </div>

            {isCamera && (
              <div
                data-testid="scanner-viewfinder"
                className="scanner-viewfinder relative w-full shrink-0 bg-black overflow-hidden modal:mx-4 modal:w-auto modal:rounded-2xl modal:border modal:border-zinc-800"
              >
                <video
                  ref={camera.videoRef}
                  className="absolute inset-0 w-full h-full object-cover"
                  playsInline
                  muted
                  autoPlay
                />

                {/* Aim frame: the same centre band of this box that the decoder reads. */}
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <div
                    data-testid="scanner-frame"
                    className="relative border-2 border-emerald-400/80 rounded-xl shadow-[0_0_0_9999px_rgba(0,0,0,0.35),0_0_20px_rgba(16,185,129,0.3)]"
                    style={{ width: `${SCAN_BAND.width * 100}%`, height: `${SCAN_BAND.height * 100}%` }}
                  >
                    <div className="scanner-line absolute left-2 right-2 h-0.5 -translate-y-1/2 bg-red-500 shadow-[0_0_8px_#ef4444]" />
                    <div className="absolute -top-1 -left-1 w-5 h-5 border-t-[3px] border-l-[3px] border-emerald-400 rounded-tl-lg" />
                    <div className="absolute -top-1 -right-1 w-5 h-5 border-t-[3px] border-r-[3px] border-emerald-400 rounded-tr-lg" />
                    <div className="absolute -bottom-1 -left-1 w-5 h-5 border-b-[3px] border-l-[3px] border-emerald-400 rounded-bl-lg" />
                    <div className="absolute -bottom-1 -right-1 w-5 h-5 border-b-[3px] border-r-[3px] border-emerald-400 rounded-br-lg" />
                  </div>
                </div>

                {camera.hasTorch && !cameraError && (
                  <button
                    type="button"
                    onClick={() => void camera.toggleTorch()}
                    className="absolute top-3 right-3 w-11 h-11 flex items-center justify-center rounded-xl bg-zinc-900/80 text-zinc-100 hover:bg-zinc-800 border border-zinc-700/60 shadow-lg"
                    title={camera.torchOn ? t('scanner.torchOff') : t('scanner.torchOn')}
                    aria-label={camera.torchOn ? t('scanner.torchOff') : t('scanner.torchOn')}
                  >
                    {camera.torchOn ? (
                      <FlashlightOff className="w-5 h-5 text-amber-400" />
                    ) : (
                      <Flashlight className="w-5 h-5 text-zinc-300" />
                    )}
                  </button>
                )}

                {camera.status === 'starting' && !cameraError && (
                  <div className="absolute inset-0 bg-zinc-950/80 flex flex-col items-center justify-center gap-2 text-zinc-300 text-xs">
                    <span className="w-6 h-6 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin" />
                    <span>{t('scanner.connecting')}</span>
                  </div>
                )}

                {cameraError && (
                  <div
                    role="alert"
                    className="absolute inset-0 overflow-y-auto bg-zinc-950 p-4 flex flex-col justify-center"
                  >
                    <div className="p-4 rounded-2xl bg-amber-950/40 border border-amber-800/80 text-amber-200 space-y-3">
                      <div className="flex items-start gap-2.5">
                        <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                        <div>
                          <h4 className="text-xs font-bold text-amber-300">
                            {cameraError === 'permission_denied'
                              ? t('scanner.permissionDeniedTitle')
                              : cameraError === 'not_supported'
                              ? t('scanner.unsupportedTitle')
                              : t('scanner.cameraErrorTitle')}
                          </h4>
                          <p className="text-xs text-amber-200/90 mt-1 leading-relaxed">
                            {cameraError === 'permission_denied'
                              ? t('scanner.permissionDenied')
                              : cameraError === 'not_supported'
                              ? t('scanner.unsupported')
                              : t('scanner.cameraError')}
                          </p>
                        </div>
                      </div>

                      <div className="flex flex-wrap gap-2 pt-1">
                        {cameraError !== 'not_supported' && (
                          <Button
                            onClick={camera.restart}
                            variant="secondary"
                            size="sm"
                            leftIcon={<RotateCcw className="w-3.5 h-3.5" />}
                          >
                            {t('scanner.retryCamera')}
                          </Button>
                        )}
                        <Button
                          onClick={() => setViewMode('manual')}
                          variant="primary"
                          size="sm"
                          leftIcon={<Keyboard className="w-3.5 h-3.5" />}
                        >
                          {t('scanner.manualTab')}
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="scanner-side flex-1 min-h-0 min-w-0 flex flex-col">
            <div
              data-testid="scanner-scroll"
              className={`flex-1 min-h-0 overflow-y-auto overscroll-contain px-3 pt-3 modal:px-4 ${
                footer ? 'pb-3' : 'pb-[max(0.75rem,env(safe-area-inset-bottom,0px))] modal:pb-4'
              }`}
            >
              {isCamera ? (
                !children && (
                  <div className="flex items-center justify-between gap-2 text-xs text-zinc-400 px-1">
                    <span>{t('scanner.trouble')}</span>
                    <button
                      type="button"
                      onClick={() => setViewMode('manual')}
                      className="min-h-[40px] text-emerald-400 font-semibold hover:underline inline-flex items-center gap-1"
                    >
                      <Keyboard className="w-3.5 h-3.5" />
                      {t('scanner.manualEntryTitle')}
                    </button>
                  </div>
                )
              ) : (
                <div className="space-y-4">
                  <form onSubmit={handleManualSubmit} className="space-y-3">
                    <Input
                      label={t('scanner.manualEntryTitle')}
                      placeholder={t('scanner.manualEntryPlaceholder')}
                      value={manualInput}
                      onChange={(e) => {
                        setManualInput(e.target.value);
                        if (manualError) setManualError('');
                      }}
                      onFocus={handleManualFocus}
                      error={manualError}
                      autoFocus
                      inputMode="text"
                      enterKeyHint="go"
                      autoComplete="off"
                      leftIcon={<Keyboard className="w-4 h-4 text-emerald-400" />}
                    />

                    <Button type="submit" variant="primary" fullWidth leftIcon={<Search className="w-4 h-4" />}>
                      {t('scanner.submitBarcode')}
                    </Button>
                  </form>

                  {import.meta.env.DEV && (
                    <div className="bg-zinc-900/60 p-3.5 rounded-2xl border border-zinc-800/80 space-y-2.5">
                      <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-300">
                        <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                        <span>{t('scanner.sampleBarcodes')}</span>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                        {SAMPLE_BARCODES.map((sample) => (
                          <button
                            key={sample.code}
                            type="button"
                            onClick={() => handleSampleBarcode(sample.code)}
                            className="p-2 text-left bg-zinc-800/60 hover:bg-zinc-800 rounded-xl border border-zinc-700/50 text-zinc-200 transition-colors"
                          >
                            <span className="font-semibold block text-emerald-400">{sample.code}</span>
                            <span className="text-[11px] text-zinc-400">{sample.label}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
              {children && <div className={isCamera ? '' : 'pt-4'}>{children}</div>}
            </div>

            {footer && (
              <div
                data-testid="scanner-footer"
                className="shrink-0 border-t border-zinc-800/80 bg-zinc-950 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom,0px))] modal:pb-3"
              >
                {footer}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
