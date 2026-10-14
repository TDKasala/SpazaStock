import React, { useEffect, useRef, useState } from 'react';
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode';
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
import { ErrorMessage } from '../ui/ErrorMessage';

export interface BarcodeScannerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onBarcodeScanned: (barcode: string) => void;
  title?: string;
}

type ScannerViewMode = 'camera' | 'manual';
type CameraErrorType = 'permission_denied' | 'not_supported' | 'device_not_found' | 'general' | null;

export const BarcodeScannerModal: React.FC<BarcodeScannerModalProps> = ({
  isOpen,
  onClose,
  onBarcodeScanned,
  title,
}) => {
  const { t } = useLanguage();
  const [viewMode, setViewMode] = useState<ScannerViewMode>('camera');
  const [cameraError, setCameraError] = useState<CameraErrorType>(null);
  const [manualInput, setManualInput] = useState('');
  const [manualError, setManualError] = useState('');
  const [isTorchOn, setIsTorchOn] = useState(false);
  const [hasTorch, setHasTorch] = useState(false);
  const [isCameraStarting, setIsCameraStarting] = useState(false);

  const scannerRef = useRef<Html5Qrcode | null>(null);
  const readerElementId = 'spazastock-barcode-reader';
  const hasDetectedRef = useRef(false);

  // Stop camera helper
  const stopCamera = async () => {
    if (scannerRef.current) {
      try {
        if (scannerRef.current.isScanning) {
          await scannerRef.current.stop();
        }
        await scannerRef.current.clear();
      } catch (err) {
        console.warn('Error stopping scanner:', err);
      } finally {
        scannerRef.current = null;
      }
    }
    setIsTorchOn(false);
    setHasTorch(false);
  };

  // Start camera scanner
  const startCamera = async () => {
    if (!isOpen) return;
    setCameraError(null);
    setIsCameraStarting(true);
    hasDetectedRef.current = false;

    // Check mediaDevices support
    if (typeof navigator === 'undefined' || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setCameraError('not_supported');
      setViewMode('manual');
      setIsCameraStarting(false);
      return;
    }

    try {
      await stopCamera();

      // Ensure element exists in DOM
      const element = document.getElementById(readerElementId);
      if (!element) {
        setIsCameraStarting(false);
        return;
      }

      const html5QrCode = new Html5Qrcode(readerElementId, {
        formatsToSupport: [
          Html5QrcodeSupportedFormats.EAN_13,
          Html5QrcodeSupportedFormats.EAN_8,
          Html5QrcodeSupportedFormats.UPC_A,
          Html5QrcodeSupportedFormats.UPC_E,
          Html5QrcodeSupportedFormats.CODE_128,
          Html5QrcodeSupportedFormats.CODE_39,
          Html5QrcodeSupportedFormats.QR_CODE,
          Html5QrcodeSupportedFormats.ITF,
        ],
        verbose: false,
      });

      scannerRef.current = html5QrCode;

      const qrCodeSuccessCallback = (decodedText: string) => {
        if (hasDetectedRef.current) return;
        hasDetectedRef.current = true;

        // Provide tactile feedback on Android mobile
        if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
          try {
            navigator.vibrate([70, 40, 70]);
          } catch {
            // Ignore if vibration disallowed
          }
        }

        stopCamera().then(() => {
          onBarcodeScanned(decodedText.trim());
        });
      };

      await html5QrCode.start(
        { facingMode: 'environment' },
        {
          fps: 15,
          qrbox: { width: 260, height: 160 },
          aspectRatio: 1.0,
        },
        qrCodeSuccessCallback,
        undefined
      );

      // Check torch capability
      try {
        const capabilities = html5QrCode.getRunningTrackCameraCapabilities();
        if (capabilities && capabilities.torchFeature().isSupported()) {
          setHasTorch(true);
        }
      } catch {
        setHasTorch(false);
      }
    } catch (err: any) {
      console.warn('Camera start error:', err);
      const errName = err?.name || '';
      const errMsg = (err?.message || '').toLowerCase();

      if (
        errName === 'NotAllowedError' ||
        errName === 'PermissionDeniedError' ||
        errMsg.includes('permission') ||
        errMsg.includes('denied')
      ) {
        setCameraError('permission_denied');
      } else if (errName === 'NotFoundError' || errName === 'DevicesNotFoundError') {
        setCameraError('device_not_found');
      } else if (errName === 'NotSupportedError') {
        setCameraError('not_supported');
      } else {
        setCameraError('general');
      }
    } finally {
      setIsCameraStarting(false);
    }
  };

  // Toggle torch
  const toggleTorch = async () => {
    if (!scannerRef.current || !hasTorch) return;
    try {
      const nextTorch = !isTorchOn;
      await scannerRef.current.applyVideoConstraints({
        advanced: [{ torch: nextTorch } as any],
      });
      setIsTorchOn(nextTorch);
    } catch (err) {
      console.warn('Torch toggle failed:', err);
    }
  };

  useEffect(() => {
    if (isOpen && viewMode === 'camera') {
      // Small timeout to allow DOM element mount
      const timer = setTimeout(() => {
        startCamera();
      }, 150);
      return () => {
        clearTimeout(timer);
        stopCamera();
      };
    } else {
      stopCamera();
    }
  }, [isOpen, viewMode]);

  // Handle manual submit
  const handleManualSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const clean = manualInput.trim();
    if (!clean) {
      setManualError(t('scanner.invalidBarcode'));
      return;
    }
    stopCamera().then(() => {
      onBarcodeScanned(clean);
    });
  };

  // Sample barcodes for quick testing on devices without actual physical barcode boxes
  const handleSampleBarcode = (sampleCode: string) => {
    setManualInput(sampleCode);
    stopCamera().then(() => {
      onBarcodeScanned(sampleCode);
    });
  };

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/85 backdrop-blur-md animate-in fade-in duration-200"
    >
      <div className="relative w-full max-w-md bg-zinc-950 border border-zinc-800 rounded-3xl overflow-hidden shadow-2xl flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800/80 bg-zinc-900/60">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-emerald-500/20 text-emerald-400 flex items-center justify-center border border-emerald-500/30">
              <Camera className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-zinc-100">{title || t('scanner.title')}</h3>
              <p className="text-[11px] text-zinc-400 leading-none mt-0.5">
                {viewMode === 'camera' ? t('scanner.instruction') : t('scanner.manualEntryTitle')}
              </p>
            </div>
          </div>
          <button
            onClick={() => {
              stopCamera();
              onClose();
            }}
            className="p-1.5 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 rounded-lg transition-colors"
            aria-label="Close scanner"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* View Mode Switcher (Camera vs Manual) */}
        <div className="grid grid-cols-2 p-1.5 m-4 bg-zinc-900/90 rounded-xl border border-zinc-800">
          <button
            onClick={() => setViewMode('camera')}
            className={`flex items-center justify-center gap-2 py-2 text-xs font-semibold rounded-lg transition-colors ${
              viewMode === 'camera'
                ? 'bg-emerald-600 text-white shadow-sm'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Camera className="w-4 h-4" />
            <span>{t('scanner.cameraTab')}</span>
          </button>
          <button
            onClick={() => setViewMode('manual')}
            className={`flex items-center justify-center gap-2 py-2 text-xs font-semibold rounded-lg transition-colors ${
              viewMode === 'manual'
                ? 'bg-emerald-600 text-white shadow-sm'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Keyboard className="w-4 h-4" />
            <span>{t('scanner.manualTab')}</span>
          </button>
        </div>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto px-4 pb-4">
          {viewMode === 'camera' ? (
            <div className="space-y-4">
              {/* Camera Error Message */}
              {cameraError && (
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

                  <div className="flex gap-2 pt-1">
                    <Button
                      onClick={startCamera}
                      variant="secondary"
                      size="sm"
                      leftIcon={<RotateCcw className="w-3.5 h-3.5" />}
                    >
                      {t('scanner.retryCamera')}
                    </Button>
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
              )}

              {/* Viewfinder Canvas Container */}
              <div
                className={`relative w-full aspect-square max-h-[320px] bg-black rounded-2xl overflow-hidden border border-zinc-800 flex items-center justify-center ${
                  cameraError ? 'hidden' : 'block'
                }`}
              >
                {/* HTML5 QR code video container */}
                <div id={readerElementId} className="w-full h-full object-cover" />

                {/* Overlay Aim Reticle */}
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
                  <div className="relative w-64 h-40 border-2 border-emerald-400/80 rounded-xl shadow-[0_0_20px_rgba(16,185,129,0.3)] flex items-center justify-center">
                    {/* Animated Red Laser Scan Line */}
                    <div className="absolute left-2 right-2 h-0.5 bg-red-500 shadow-[0_0_8px_#ef4444] animate-pulse" />
                    {/* Corner Reticle Accents */}
                    <div className="absolute -top-1 -left-1 w-4 h-4 border-t-2 border-l-2 border-emerald-400" />
                    <div className="absolute -top-1 -right-1 w-4 h-4 border-t-2 border-r-2 border-emerald-400" />
                    <div className="absolute -bottom-1 -left-1 w-4 h-4 border-b-2 border-l-2 border-emerald-400" />
                    <div className="absolute -bottom-1 -right-1 w-4 h-4 border-b-2 border-r-2 border-emerald-400" />
                  </div>
                </div>

                {/* Torch Button if available */}
                {hasTorch && (
                  <button
                    onClick={toggleTorch}
                    className="absolute top-3 right-3 p-2 rounded-xl bg-zinc-900/80 text-zinc-100 hover:bg-zinc-800 border border-zinc-700/60 shadow-lg"
                    title={isTorchOn ? t('scanner.torchOff') : t('scanner.torchOn')}
                  >
                    {isTorchOn ? (
                      <FlashlightOff className="w-5 h-5 text-amber-400" />
                    ) : (
                      <Flashlight className="w-5 h-5 text-zinc-300" />
                    )}
                  </button>
                )}

                {/* Initializing indicator */}
                {isCameraStarting && (
                  <div className="absolute inset-0 bg-zinc-950/80 flex flex-col items-center justify-center gap-2 text-zinc-300 text-xs">
                    <span className="w-6 h-6 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin" />
                    <span>Connecting camera...</span>
                  </div>
                )}
              </div>

              {/* Bottom Switch to Manual shortcut */}
              <div className="flex items-center justify-between text-xs text-zinc-400 px-1">
                <span>Trouble scanning?</span>
                <button
                  onClick={() => setViewMode('manual')}
                  className="text-emerald-400 font-semibold hover:underline inline-flex items-center gap-1"
                >
                  <Keyboard className="w-3.5 h-3.5" />
                  {t('scanner.manualEntryTitle')}
                </button>
              </div>
            </div>
          ) : (
            /* Manual Barcode Entry Mode */
            <div className="space-y-4 py-2">
              <form onSubmit={handleManualSubmit} className="space-y-3">
                <Input
                  label={t('scanner.manualEntryTitle')}
                  placeholder={t('scanner.manualEntryPlaceholder')}
                  value={manualInput}
                  onChange={(e) => {
                    setManualInput(e.target.value);
                    if (manualError) setManualError('');
                  }}
                  error={manualError}
                  autoFocus
                  inputMode="text"
                  autoComplete="off"
                  leftIcon={<Keyboard className="w-4 h-4 text-emerald-400" />}
                />

                <Button
                  type="submit"
                  variant="primary"
                  fullWidth
                  leftIcon={<Search className="w-4 h-4" />}
                >
                  {t('scanner.submitBarcode')}
                </Button>
              </form>

              {/* Quick Testing Barcodes (Very handy for desktop/mobile testing without a store barcode on hand) */}
              <div className="bg-zinc-900/60 p-3.5 rounded-2xl border border-zinc-800/80 space-y-2.5">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-300">
                  <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                  <span>Test Sample Barcodes:</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                  <button
                    type="button"
                    onClick={() => handleSampleBarcode('6001007300123')}
                    className="p-2 text-left bg-zinc-800/60 hover:bg-zinc-800 rounded-xl border border-zinc-700/50 text-zinc-200 transition-colors"
                  >
                    <span className="font-semibold block text-emerald-400">6001007300123</span>
                    <span className="text-[11px] text-zinc-400">Albany White Bread</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSampleBarcode('5449000000996')}
                    className="p-2 text-left bg-zinc-800/60 hover:bg-zinc-800 rounded-xl border border-zinc-700/50 text-zinc-200 transition-colors"
                  >
                    <span className="font-semibold block text-emerald-400">5449000000996</span>
                    <span className="text-[11px] text-zinc-400">Coca-Cola 330ml Can</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSampleBarcode('6001087361250')}
                    className="p-2 text-left bg-zinc-800/60 hover:bg-zinc-800 rounded-xl border border-zinc-700/50 text-zinc-200 transition-colors"
                  >
                    <span className="font-semibold block text-emerald-400">6001087361250</span>
                    <span className="text-[11px] text-zinc-400">Simba Chips Smoked Beef</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSampleBarcode('6001062000549')}
                    className="p-2 text-left bg-zinc-800/60 hover:bg-zinc-800 rounded-xl border border-zinc-700/50 text-zinc-200 transition-colors"
                  >
                    <span className="font-semibold block text-emerald-400">6001062000549</span>
                    <span className="text-[11px] text-zinc-400">Sunlight Dishwashing 750ml</span>
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
