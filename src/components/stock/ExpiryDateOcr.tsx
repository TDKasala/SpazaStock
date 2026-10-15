import React, { useRef, useState } from 'react';
import { Camera, ImagePlus, Loader2, RefreshCw } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import {
  ExpiryOcrError,
  recognizeExpiryDate,
  type ExpiryDateCandidate,
  type ExpiryOcrErrorCode,
} from '../../lib/expiryOcrRunner';

export interface ExpiryDateOcrProps {
  /** Fills the editable Stock-In date field after a clear suggestion or a chosen candidate. */
  onSuggest: (isoDate: string) => void;
  disabled?: boolean;
}

type OcrUiState =
  | { kind: 'idle' }
  | { kind: 'reading' }
  | { kind: 'suggested'; isoDate: string }
  | { kind: 'pick'; candidates: ExpiryDateCandidate[] }
  | { kind: 'error'; code: ExpiryOcrErrorCode };

const smallButton =
  'inline-flex items-center gap-1.5 px-3 py-2 min-h-[38px] rounded-xl text-xs font-medium border transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

export const ExpiryDateOcr: React.FC<ExpiryDateOcrProps> = ({ onSuggest, disabled }) => {
  const { t } = useLanguage();
  const cameraInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<OcrUiState>({ kind: 'idle' });
  const lastFile = useRef<File | null>(null);

  const runOcr = async (file: File) => {
    lastFile.current = file;
    setState({ kind: 'reading' });
    try {
      const result = await recognizeExpiryDate(file);
      if (result.decision.kind === 'suggest') {
        onSuggest(result.decision.isoDate);
        setState({ kind: 'suggested', isoDate: result.decision.isoDate });
        return;
      }
      if (result.decision.kind === 'pick') {
        setState({ kind: 'pick', candidates: result.decision.candidates });
        return;
      }
      setState({ kind: 'error', code: 'no_date' });
    } catch (err) {
      const code = err instanceof ExpiryOcrError ? err.code : 'unavailable';
      setState({ kind: 'error', code });
    }
  };

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    void runOcr(file);
  };

  const retry = () => {
    if (lastFile.current) void runOcr(lastFile.current);
    else cameraInput.current?.click();
  };

  return (
    <div className="space-y-2">
      <input
        ref={cameraInput}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={handleFile}
      />
      <input ref={fileInput} type="file" accept="image/*" className="hidden" onChange={handleFile} />

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={disabled || state.kind === 'reading'}
          onClick={() => cameraInput.current?.click()}
          className={`${smallButton} bg-zinc-800/80 text-zinc-200 border-zinc-700 hover:bg-zinc-800`}
        >
          <Camera className="w-3.5 h-3.5 text-amber-400" />
          {t('stockIn.ocrScan')}
        </button>
        <button
          type="button"
          disabled={disabled || state.kind === 'reading'}
          onClick={() => fileInput.current?.click()}
          className={`${smallButton} bg-zinc-800/80 text-zinc-200 border-zinc-700 hover:bg-zinc-800`}
        >
          <ImagePlus className="w-3.5 h-3.5 text-zinc-400" />
          {t('stockIn.ocrChoose')}
        </button>
      </div>

      {state.kind === 'reading' && (
        <p className="flex items-center gap-1.5 text-[11px] text-zinc-300">
          <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-400" />
          {t('stockIn.ocrReading')}
        </p>
      )}

      {state.kind === 'suggested' && (
        <p className="text-[11px] text-emerald-400/90 leading-relaxed">{t('stockIn.ocrSuggested')}</p>
      )}

      {state.kind === 'pick' && (
        <div className="space-y-1.5">
          <p className="text-[11px] text-amber-300/90">{t('stockIn.ocrPickOne')}</p>
          <div className="flex flex-wrap gap-1.5">
            {state.candidates.map((c) => (
              <button
                key={c.isoDate}
                type="button"
                disabled={disabled}
                onClick={() => {
                  onSuggest(c.isoDate);
                  setState({ kind: 'suggested', isoDate: c.isoDate });
                }}
                className="text-[10px] font-medium px-2.5 py-1 rounded-lg border bg-amber-500/15 text-amber-200 border-amber-500/40 hover:bg-amber-500/25"
              >
                {t('stockIn.ocrCandidate', { date: c.isoDate })}
              </button>
            ))}
          </div>
        </div>
      )}

      {state.kind === 'error' && (
        <div className="flex items-start justify-between gap-2">
          <p className="text-[11px] text-rose-300/90 leading-relaxed">{t(`stockIn.ocrErrors.${state.code}`)}</p>
          <button
            type="button"
            disabled={disabled}
            onClick={retry}
            className={`${smallButton} shrink-0 h-8 px-2.5 bg-zinc-900 text-zinc-300 border-zinc-700`}
          >
            <RefreshCw className="w-3.5 h-3.5" />
            {t('stockIn.ocrRetry')}
          </button>
        </div>
      )}
    </div>
  );
};
