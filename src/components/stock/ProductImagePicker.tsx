import React, { useEffect, useRef, useState } from 'react';
import { Camera, CheckCircle2, CloudOff, ImagePlus, Loader2, RefreshCw, Trash2, UploadCloud } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { useSyncStatus } from '../../hooks/useSyncStatus';
import { ImageCompressionError, compressProductImage, type CompressedImage } from '../../lib/imageCompression';
import { ErrorMessage } from '../ui/ErrorMessage';
import { ProductThumbnail, useProductImage } from './ProductThumbnail';

/** What the form will do with the picture when it is saved. */
export type ImageDraft =
  | { kind: 'unchanged' }
  | { kind: 'new'; image: CompressedImage }
  | { kind: 'removed' };

export const UNCHANGED_IMAGE: ImageDraft = { kind: 'unchanged' };

export interface ProductImagePickerProps {
  /** The product's saved picture, if any. */
  currentPath?: string | null;
  draft: ImageDraft;
  onChange: (draft: ImageDraft) => void;
  /** Whether an existing picture may be replaced or removed (owners and managers). */
  canChange?: boolean;
  /** The picture was filled in from the shared catalog and is not saved on this product yet. */
  shared?: boolean;
  disabled?: boolean;
}

const smallButton =
  'inline-flex items-center gap-1.5 px-3 py-2 min-h-[38px] rounded-xl text-xs font-medium border transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

export const ProductImagePicker: React.FC<ProductImagePickerProps> = ({
  currentPath = null,
  draft,
  onChange,
  canChange = true,
  shared = false,
  disabled,
}) => {
  const { t } = useLanguage();
  const { status } = useSyncStatus();
  const cameraInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [isCompressing, setIsCompressing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const saved = useProductImage(draft.kind === 'unchanged' ? currentPath : null);

  useEffect(() => {
    if (draft.kind !== 'new') {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(new Blob([draft.image.bytes], { type: draft.image.mimeType }));
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [draft]);

  const shownPath = draft.kind === 'unchanged' ? currentPath : null;
  const hasPicture = draft.kind === 'new' || Boolean(shownPath);
  const locked = Boolean(currentPath) && !canChange;

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    setIsCompressing(true);
    try {
      onChange({ kind: 'new', image: await compressProductImage(file) });
    } catch (err) {
      const code = err instanceof ImageCompressionError ? err.code : 'decode_failed';
      setError(t(`productImage.errors.${code}`));
    } finally {
      setIsCompressing(false);
    }
  };

  const handleRemove = () => {
    setError(null);
    onChange(currentPath ? { kind: 'removed' } : UNCHANGED_IMAGE);
  };

  const statusLine = (() => {
    if (isCompressing) {
      return (
        <span className="flex items-center gap-1.5 text-zinc-300">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          {t('productImage.compressing')}
        </span>
      );
    }
    if (draft.kind === 'new') {
      return (
        <span className="text-zinc-400">
          {t('productImage.ready', { size: Math.max(1, Math.round(draft.image.bytes.byteLength / 1024)) })}
        </span>
      );
    }
    if (draft.kind === 'removed') return <span className="text-zinc-400">{t('productImage.willRemove')}</span>;
    if (shared && shownPath) return <span className="text-zinc-400">{t('product.lookupSharedImageHint')}</span>;
    if (!shownPath) return <span className="text-zinc-500">{t('productImage.optional')}</span>;
    if (!saved.pending) {
      return (
        <span className="flex items-center gap-1.5 text-emerald-400">
          <CheckCircle2 className="w-3.5 h-3.5" />
          {t('productImage.uploaded')}
        </span>
      );
    }
    return status.isOnline && status.isSyncing ? (
      <span className="flex items-center gap-1.5 text-sky-300">
        <UploadCloud className="w-3.5 h-3.5 animate-pulse" />
        {t('productImage.uploading')}
      </span>
    ) : (
      <span className="flex items-center gap-1.5 text-amber-300">
        <CloudOff className="w-3.5 h-3.5" />
        {t('productImage.waiting')}
      </span>
    );
  })();

  return (
    <div className="space-y-2">
      <span className="text-xs font-medium text-zinc-300">{t('productImage.label')}</span>
      <div className="flex items-center gap-3">
        <ProductThumbnail path={shownPath} previewUrl={previewUrl} size="form" alt={t('productImage.previewAlt')} />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap gap-2">
            {!hasPicture ? (
              <>
                <button
                  type="button"
                  onClick={() => cameraInput.current?.click()}
                  disabled={disabled || isCompressing}
                  className={`${smallButton} bg-emerald-600/15 border-emerald-500/30 text-emerald-300 hover:bg-emerald-600/25`}
                >
                  <Camera className="w-4 h-4" />
                  {t('productImage.takePhoto')}
                </button>
                <button
                  type="button"
                  onClick={() => fileInput.current?.click()}
                  disabled={disabled || isCompressing}
                  className={`${smallButton} bg-zinc-900 border-zinc-800 text-zinc-200 hover:bg-zinc-800`}
                >
                  <ImagePlus className="w-4 h-4" />
                  {t('productImage.choosePhoto')}
                </button>
              </>
            ) : (
              !locked && (
                <>
                  <button
                    type="button"
                    onClick={() => cameraInput.current?.click()}
                    disabled={disabled || isCompressing}
                    className={`${smallButton} bg-emerald-600/15 border-emerald-500/30 text-emerald-300 hover:bg-emerald-600/25`}
                  >
                    <Camera className="w-4 h-4" />
                    {t('productImage.takePhoto')}
                  </button>
                  <button
                    type="button"
                    onClick={() => fileInput.current?.click()}
                    disabled={disabled || isCompressing}
                    className={`${smallButton} bg-zinc-900 border-zinc-800 text-zinc-200 hover:bg-zinc-800`}
                  >
                    <RefreshCw className="w-4 h-4" />
                    {t('productImage.replace')}
                  </button>
                  <button
                    type="button"
                    onClick={handleRemove}
                    disabled={disabled || isCompressing}
                    className={`${smallButton} bg-transparent border-zinc-800 text-rose-300 hover:bg-rose-950/40`}
                  >
                    <Trash2 className="w-4 h-4" />
                    {t('productImage.remove')}
                  </button>
                </>
              )
            )}
          </div>
          <p className="text-[11px]" aria-live="polite">
            {statusLine}
          </p>
        </div>
      </div>
      {error && <ErrorMessage variant="error" message={error} onDismiss={() => setError(null)} />}
      <input
        ref={cameraInput}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => void handleFile(e)}
      />
      <input ref={fileInput} type="file" accept="image/*" className="hidden" onChange={(e) => void handleFile(e)} />
    </div>
  );
};
