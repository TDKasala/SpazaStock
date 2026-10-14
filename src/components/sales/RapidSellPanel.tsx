import React from 'react';
import { AlertTriangle, CheckCircle2, CloudOff, Info, Layers, Minus, Plus, Undo2 } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { Button } from '../ui/Button';
import { canUndoLine, type SaleRegister, type ScanLine } from '../../hooks/useSaleRegister';
import { saleNetAmount, saleNetQuantity, type SaleSyncState } from '../../services/salesService';

const QUICK_PICKS = [2, 3, 5, 10];
const VISIBLE_LINES = 6;

export const SyncChip: React.FC<{ state?: SaleSyncState }> = ({ state }) => {
  const { t } = useLanguage();
  if (!state) return null;
  const failed = state === 'failed';
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${
        failed ? 'bg-rose-950/60 text-rose-300 border border-rose-800/70' : 'bg-amber-950/60 text-amber-300 border border-amber-800/70'
      }`}
    >
      {failed ? <AlertTriangle className="w-3 h-3" /> : <CloudOff className="w-3 h-3" />}
      {failed ? t('rapid.syncFailed') : t('rapid.waitingToSync')}
    </span>
  );
};

function lineAmount(line: ScanLine): number {
  return saleNetAmount({
    quantity: line.quantity,
    voidedQuantity: line.voidedQuantity,
    unitPrice: line.unitPrice,
    totalAmount: Math.round(line.unitPrice * line.quantity * 100) / 100,
  });
}

export interface RapidSellPanelProps {
  register: SaleRegister;
  onDone: () => void;
}

/** Live feedback and corrections shown under the camera while rapid selling. */
export const RapidSellPanel: React.FC<RapidSellPanelProps> = ({ register, onDone }) => {
  const { t } = useLanguage();
  const { lines, lastLine, notice, syncStates, increaseLast, decreaseLast, undo } = register;

  const productLines = lastLine ? lines.filter((l) => l.product.id === lastLine.product.id) : [];
  const productNet = productLines.reduce((sum, l) => sum + saleNetQuantity(l), 0);
  const canDecrease = productLines.some((l) => canUndoLine(l));
  const sessionUnits = lines.reduce((sum, l) => sum + saleNetQuantity(l), 0);
  const sessionAmount = lines.reduce((sum, l) => sum + lineAmount(l), 0);

  const noticeStyles = {
    success: 'bg-emerald-950/60 border-emerald-500/60 text-emerald-200',
    info: 'bg-sky-950/60 border-sky-700/60 text-sky-200',
    error: 'bg-rose-950/60 border-rose-700/70 text-rose-200',
  } as const;
  const NoticeIcon = notice?.tone === 'success' ? CheckCircle2 : notice?.tone === 'error' ? AlertTriangle : Info;

  return (
    <div className="space-y-3">
      {notice ? (
        <div
          key={notice.id}
          role="status"
          aria-live="polite"
          className={`p-3 rounded-2xl border text-sm font-semibold flex items-center gap-2 animate-in fade-in zoom-in-95 ${noticeStyles[notice.tone]}`}
        >
          <NoticeIcon className="w-4 h-4 shrink-0" />
          <span>{notice.message}</span>
        </div>
      ) : (
        <p className="text-xs text-zinc-400 text-center">{t('rapid.keepScanning')}</p>
      )}

      {lastLine && (
        <div className="p-3.5 bg-zinc-900/80 border border-zinc-800 rounded-2xl space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-zinc-400 font-mono">{lastLine.product.barcode}</span>
                <SyncChip state={syncStates.get(lastLine.saleId)} />
              </div>
              <h4 className="text-base font-bold text-zinc-100 truncate">{lastLine.product.name}</h4>
              <span className="text-[11px] text-zinc-400 flex items-center gap-1 mt-0.5">
                <Layers className="w-3 h-3 text-emerald-400" />
                {lastLine.expiryDate
                  ? t('sales.deductedFromExpiry', { date: lastLine.expiryDate })
                  : t('sales.deductedNonPerishable')}
              </span>
            </div>
            <div className="text-right shrink-0">
              <span
                className={`text-2xl font-extrabold block ${lastLine.remainingStock === 0 ? 'text-rose-400' : 'text-emerald-400'}`}
              >
                {lastLine.remainingStock}
              </span>
              <span className="text-[11px] text-zinc-400">{t('rapid.stockLeft', { count: lastLine.remainingStock })}</span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void decreaseLast()}
              disabled={!canDecrease}
              aria-label={t('rapid.lessOne')}
              className="w-12 h-12 bg-zinc-950 rounded-xl border border-zinc-800 flex items-center justify-center text-zinc-200 disabled:opacity-40"
            >
              <Minus className="w-5 h-5" />
            </button>
            <div className="flex-1 h-12 bg-zinc-950 border border-zinc-800 rounded-xl flex items-center justify-center font-bold text-xl text-zinc-100">
              {productNet}
            </div>
            <button
              type="button"
              onClick={() => void increaseLast(1)}
              aria-label={t('rapid.moreOne')}
              className="w-12 h-12 bg-emerald-700 rounded-xl border border-emerald-600 flex items-center justify-center text-white"
            >
              <Plus className="w-5 h-5" />
            </button>
          </div>

          <div className="space-y-1.5">
            <span className="text-[11px] text-zinc-400">{t('rapid.sellMoreLabel')}</span>
            <div className="grid grid-cols-4 gap-2">
              {QUICK_PICKS.map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => void increaseLast(n)}
                  className="py-1.5 bg-zinc-950 hover:bg-zinc-800 text-xs font-semibold text-zinc-300 rounded-lg border border-zinc-800"
                >
                  +{n}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {lines.length > 0 && (
        <div className="space-y-1.5">
          {lines.slice(0, VISIBLE_LINES).map((line) => {
            const net = saleNetQuantity(line);
            return (
              <div
                key={line.saleId}
                className="px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-xl flex items-center justify-between gap-2 text-xs"
              >
                <div className="min-w-0 flex-1">
                  <span className={`font-semibold block truncate ${net === 0 ? 'text-zinc-500 line-through' : 'text-zinc-100'}`}>
                    {net} × {line.product.name}
                  </span>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    {line.voidedQuantity > 0 && (
                      <span className="text-[10px] text-zinc-500">{t('sales.voidedCount', { count: line.voidedQuantity })}</span>
                    )}
                    <SyncChip state={syncStates.get(line.saleId)} />
                  </div>
                </div>
                <span className="font-bold text-emerald-400 shrink-0">R {lineAmount(line).toFixed(2)}</span>
                {canUndoLine(line) && (
                  <button
                    type="button"
                    onClick={() => void undo(line.saleId)}
                    className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-zinc-700 text-zinc-300 hover:bg-zinc-800"
                  >
                    <Undo2 className="w-3.5 h-3.5" />
                    {t('rapid.undo')}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="flex items-center justify-between gap-3 pt-1">
        <span className="text-xs text-zinc-300 font-medium">
          {t('rapid.sessionTotal', { units: sessionUnits, amount: sessionAmount.toFixed(2) })}
        </span>
        <Button onClick={onDone} variant="primary" size="sm">
          {t('rapid.done')}
        </Button>
      </div>
    </div>
  );
};
