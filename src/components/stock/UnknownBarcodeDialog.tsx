import React from 'react';
import { Barcode, Link2, PackagePlus } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { ErrorMessage } from '../ui/ErrorMessage';

export interface UnknownBarcodeDialogProps {
  isOpen: boolean;
  barcode: string;
  /** Owners and managers can link a barcode to a product that already exists. */
  canLink: boolean;
  onLinkExisting: () => void;
  onCreateNew: () => void;
  onClose: () => void;
}

/**
 * Shown when a delivery is scanned with a barcode the shop does not know. The same product often
 * arrives with a new barcode (a case, a new supplier code), so linking it is offered before
 * registering a duplicate product.
 */
export const UnknownBarcodeDialog: React.FC<UnknownBarcodeDialogProps> = ({
  isOpen,
  barcode,
  canLink,
  onLinkExisting,
  onCreateNew,
  onClose,
}) => {
  const { t } = useLanguage();
  if (!isOpen) return null;

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={t('unknownBarcode.title')}
      description={t('unknownBarcode.subtitle')}
      footer={
        <Button onClick={onClose} variant="secondary" size="md" className="flex-1">
          {t('common.cancel')}
        </Button>
      }
    >
      <div className="space-y-3 py-1">
        <div className="flex items-center gap-2 p-3 rounded-xl bg-zinc-950 border border-zinc-800 font-mono text-sm text-zinc-200 break-all">
          <Barcode className="w-4 h-4 text-emerald-400 shrink-0" />
          <span data-testid="unknown-barcode">{barcode}</span>
        </div>

        {canLink && (
          <button
            type="button"
            onClick={onLinkExisting}
            className="w-full text-left p-4 rounded-2xl border border-emerald-500/40 bg-emerald-950/30 hover:bg-emerald-950/50 active:bg-emerald-950/70 transition-colors flex items-start gap-3"
          >
            <span className="w-10 h-10 rounded-xl bg-emerald-500 text-zinc-950 flex items-center justify-center shrink-0">
              <Link2 className="w-5 h-5" />
            </span>
            <span>
              <span className="block text-sm font-bold text-emerald-200">{t('unknownBarcode.linkExisting')}</span>
              <span className="block text-xs text-emerald-100/70 mt-0.5 leading-relaxed">
                {t('unknownBarcode.linkExistingHint')}
              </span>
            </span>
          </button>
        )}

        <button
          type="button"
          onClick={onCreateNew}
          className="w-full text-left p-4 rounded-2xl border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 active:bg-zinc-800/80 transition-colors flex items-start gap-3"
        >
          <span className="w-10 h-10 rounded-xl bg-zinc-800 text-zinc-100 flex items-center justify-center shrink-0">
            <PackagePlus className="w-5 h-5" />
          </span>
          <span>
            <span className="block text-sm font-bold text-zinc-100">{t('unknownBarcode.createNew')}</span>
            <span className="block text-xs text-zinc-400 mt-0.5 leading-relaxed">
              {t('unknownBarcode.createNewHint')}
            </span>
          </span>
        </button>

        {!canLink && <ErrorMessage variant="info" message={t('unknownBarcode.askManager')} />}
      </div>
    </Dialog>
  );
};
