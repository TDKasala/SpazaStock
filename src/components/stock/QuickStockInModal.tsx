import React, { useState, useEffect } from 'react';
import { Calendar, CheckCircle2, Plus, Minus, Barcode, ArrowRight } from 'lucide-react';
import type { Product, ProductPackaging, StockInResult } from '../../types';
import { useLanguage } from '../../context/LanguageContext';
import { useShopId } from '../../context/ShopContext';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { ErrorMessage } from '../ui/ErrorMessage';
import { stockIn, getProductTotalStock, isValidDateFormat } from '../../services/stockService';
import { db } from '../../lib/db';
import { getPackagings } from '../../services/barcodeLinkService';
import { addDaysLocal } from '../../lib/dates';
import { newId } from '../../lib/ids';
import { packagingLabel } from './packagingLabel';

export interface QuickStockInModalProps {
  isOpen: boolean;
  product: Product | null;
  /** Preselects the pack or case whose barcode was scanned. */
  packagingId?: string | null;
  /** The alias that was scanned, recorded on the delivery. */
  barcodeId?: string | null;
  onClose: () => void;
  onStockInSuccess?: (result: StockInResult) => void;
  onStockInAnother?: () => void;
}

const getPresetDate = (daysAhead: number): string => addDaysLocal(daysAhead);

const toCents = (value: number): number => Math.round(value * 100) / 100;

export const QuickStockInModal: React.FC<QuickStockInModalProps> = ({
  isOpen,
  product,
  packagingId = null,
  barcodeId = null,
  onClose,
  onStockInSuccess,
  onStockInAnother,
}) => {
  const { t, dict } = useLanguage();
  const shopId = useShopId();

  const [currentStock, setCurrentStock] = useState<number>(0);
  const [quantityInput, setQuantityInput] = useState<string>('1');
  const [hasExpiry, setHasExpiry] = useState<boolean>(true);
  const [expiryDate, setExpiryDate] = useState<string>('');
  const [costPrice, setCostPrice] = useState<string>('');
  const [lotNumber, setLotNumber] = useState('');
  const [supplierName, setSupplierName] = useState('');
  const [scannedBarcode, setScannedBarcode] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [successResult, setSuccessResult] = useState<StockInResult | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState<string>('');
  const [packagings, setPackagings] = useState<ProductPackaging[]>([]);
  const [selectedPackagingId, setSelectedPackagingId] = useState<string | null>(null);

  // Reset modal state when product or openness changes
  useEffect(() => {
    if (isOpen && product) {
      setSuccessResult(null);
      setErrorMsg(null);
      setQuantityInput('1');
      setIsSubmitting(false);
      setIdempotencyKey(newId());
      setPackagings([]);
      setSelectedPackagingId(null);

      // Perishables default to expiry enabled with a sensible preset
      const isPerishable = ['bakery', 'dairy', 'groceries', 'beverages', 'snacks'].includes(
        product.category
      );
      setHasExpiry(isPerishable);
      if (product.category === 'bakery') {
        setExpiryDate(getPresetDate(5)); // e.g. bread ~5 days
      } else if (product.category === 'dairy') {
        setExpiryDate(getPresetDate(10)); // milk ~10 days
      } else if (isPerishable) {
        setExpiryDate(getPresetDate(30)); // 1 month
      } else {
        setExpiryDate('');
      }

      setCostPrice(product.buyingPrice != null ? String(product.buyingPrice) : '');
      setLotNumber('');
      setSupplierName('');
      setScannedBarcode(null);
      if (barcodeId) {
        void db.barcodes.get(barcodeId).then((link) => {
          if (link && link.shopId === shopId) setScannedBarcode(link.barcode);
        });
      }

      void getProductTotalStock(product.id, shopId).then(setCurrentStock);
      void getPackagings(product.id, shopId).then((found) => {
        setPackagings(found);
        const scanned = found.find((p) => p.id === packagingId);
        if (scanned) {
          setSelectedPackagingId(scanned.id);
          if (product.buyingPrice != null) {
            setCostPrice(String(toCents(Number(product.buyingPrice) * scanned.unitsPerPackage)));
          }
        }
      });
    }
  }, [isOpen, product, packagingId, barcodeId, shopId]);

  if (!isOpen || !product) return null;

  const selectedPackaging = packagings.find((p) => p.id === selectedPackagingId) ?? null;
  const unitsPerPackage = selectedPackaging?.unitsPerPackage ?? 1;
  const enteredQuantity = Number(quantityInput);
  const unitsToAdd = Number.isInteger(enteredQuantity) && enteredQuantity > 0 ? enteredQuantity * unitsPerPackage : 0;

  /** Switching between units and packages keeps the typed cost by converting it. */
  const selectPackaging = (next: ProductPackaging | null) => {
    const nextUnits = next?.unitsPerPackage ?? 1;
    const cost = parseFloat(costPrice);
    if (costPrice.trim() && !isNaN(cost)) setCostPrice(String(toCents((cost / unitsPerPackage) * nextUnits)));
    setSelectedPackagingId(next?.id ?? null);
    setQuantityInput('1');
    setErrorMsg(null);
  };

  // Handle Quick Quantity Presets
  const handleQuickAdd = (delta: number) => {
    const current = parseInt(quantityInput, 10);
    const validCurrent = isNaN(current) || current < 0 ? 0 : current;
    const nextVal = Math.max(1, validCurrent + delta);
    setQuantityInput(String(nextVal));
    setErrorMsg(null);
  };

  const handleSetQuantity = (val: number) => {
    setQuantityInput(String(Math.max(1, val)));
    setErrorMsg(null);
  };

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (isSubmitting) return;

    setErrorMsg(null);

    // Validate Quantity
    const qty = Number(quantityInput);
    if (!Number.isInteger(qty) || qty <= 0) {
      setErrorMsg(t('stockIn.invalidQuantity'));
      return;
    }

    // Validate Expiry Date if enabled
    let finalExpiry: string | null = null;
    if (hasExpiry) {
      const trimmedDate = expiryDate.trim();
      if (!trimmedDate || !isValidDateFormat(trimmedDate)) {
        setErrorMsg(t('stockIn.invalidDate'));
        return;
      }
      finalExpiry = trimmedDate;
    }

    // Optional cost price
    let parsedCost: number | null = null;
    if (costPrice.trim()) {
      const num = parseFloat(costPrice.trim());
      if (isNaN(num) || num < 0) {
        setErrorMsg(t('errors.invalidNumber'));
        return;
      }
      parsedCost = num;
    }

    setIsSubmitting(true);

    try {
      const res = await stockIn(
        {
          productId: product.id,
          quantity: qty,
          expiryDate: finalExpiry,
          // Cost is typed per package when receiving packages; it is stored per unit.
          costPricePerUnit: parsedCost == null ? null : toCents(parsedCost / unitsPerPackage),
          idempotencyKey,
          packagingId: selectedPackaging?.id ?? null,
          barcodeId,
          lotNumber,
          supplierName,
        },
        shopId
      );

      if (res.error) {
        setErrorMsg(res.error);
        return;
      }

      if (res.result) {
        setSuccessResult(res.result);
        setCurrentStock(res.result.resultingTotalQuantity);
        onStockInSuccess?.(res.result);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : t('errors.generic'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const categoryName = dict.product.categories[product.category] || product.category;

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={t('stockIn.title')}
      description={t('stockIn.subtitle')}
      footer={
        successResult ? (
          <div className="flex w-full gap-2">
            {onStockInAnother && (
              <Button
                onClick={() => {
                  setSuccessResult(null);
                  onStockInAnother();
                }}
                variant="secondary"
                size="md"
                className="flex-1"
                leftIcon={<Plus className="w-4 h-4" />}
              >
                {t('stockIn.stockInAnother')}
              </Button>
            )}
            <Button onClick={onClose} variant="primary" size="md" className="flex-1">
              {t('common.close')}
            </Button>
          </div>
        ) : (
          <div className="flex w-full gap-2">
            <Button
              onClick={onClose}
              variant="secondary"
              size="md"
              className="flex-1"
              disabled={isSubmitting}
            >
              {t('common.cancel')}
            </Button>
            <Button
              onClick={handleSubmit}
              variant="primary"
              size="md"
              className="flex-1"
              isLoading={isSubmitting}
              leftIcon={<CheckCircle2 className="w-4 h-4" />}
            >
              {t('stockIn.saveStockIn')}
            </Button>
          </div>
        )
      }
    >
      <div className="space-y-4 py-1">
        {/* Product Identity Header */}
        <div className="p-3.5 bg-zinc-950 rounded-2xl border border-zinc-800 flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                {categoryName}
              </span>
              <span className="text-xs text-zinc-400 font-mono flex items-center gap-1">
                <Barcode className="w-3.5 h-3.5 text-zinc-500" />
                {scannedBarcode ?? product.barcode}
              </span>
            </div>
            <h3 className="text-sm font-bold text-zinc-100 truncate mt-1">
              {product.name}
            </h3>
          </div>

          {/* Current Stock Pill */}
          <div className="text-right shrink-0 bg-zinc-900 px-3 py-1.5 rounded-xl border border-zinc-800">
            <span className="text-[10px] text-zinc-400 block">{t('stockIn.currentStock')}</span>
            <span className="text-sm font-bold text-zinc-200">
              {currentStock} <span className="text-[10px] text-zinc-400">{t('stockIn.units')}</span>
            </span>
          </div>
        </div>

        {/* Success Confirmation Card (Instant Available Stock Feedback) */}
        {successResult ? (
          <div className="p-5 bg-emerald-950/40 border border-emerald-500/40 rounded-2xl space-y-4 animate-in fade-in zoom-in-95">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-emerald-500 text-zinc-950 flex items-center justify-center font-bold">
                <CheckCircle2 className="w-6 h-6" />
              </div>
              <div>
                <h4 className="text-sm font-bold text-emerald-300">
                  {t('stockIn.successTitle')}
                </h4>
                <p className="text-xs text-emerald-200/80 mt-0.5">
                  {t('stockIn.batchRecorded')}
                </p>
              </div>
            </div>

            {/* Arithmetic Stock Banner */}
            <div className="p-3.5 bg-zinc-950/80 rounded-xl border border-emerald-500/30 flex items-center justify-around text-center">
              <div>
                <span className="text-[10px] text-zinc-400 block">{t('stockIn.previousStock')}</span>
                <span className="text-sm font-semibold text-zinc-300">
                  {successResult.previousTotalQuantity}
                </span>
              </div>
              <span className="text-emerald-400 font-bold text-base">+</span>
              <div>
                <span className="text-[10px] text-zinc-400 block">{t('stockIn.addedAmount')}</span>
                <span className="text-sm font-bold text-emerald-400">
                  +{successResult.batch.quantity}
                </span>
              </div>
              <ArrowRight className="w-4 h-4 text-emerald-500" />
              <div>
                <span className="text-[10px] text-emerald-300 font-semibold block">
                  {t('stockIn.newTotalStock')}
                </span>
                <span className="text-lg font-extrabold text-emerald-400">
                  {successResult.resultingTotalQuantity} {t('stockIn.units')}
                </span>
              </div>
            </div>

            {successResult.batch.packageQuantity && successResult.batch.unitsPerPackage && (
              <p className="text-xs text-emerald-200/90 text-center" data-testid="stock-in-packages">
                {t('stockIn.addedPackages', {
                  count: successResult.batch.packageQuantity,
                  pack: packagingLabel(
                    {
                      name: selectedPackaging?.name ?? '',
                      unitsPerPackage: successResult.batch.unitsPerPackage,
                    },
                    t
                  ),
                  units: successResult.batch.quantity,
                })}
              </p>
            )}

            {successResult.batch.expiryDate && (
              <div className="flex items-center gap-2 text-xs text-zinc-300 bg-zinc-900/60 p-2.5 rounded-xl border border-zinc-800">
                <Calendar className="w-4 h-4 text-amber-400 shrink-0" />
                <span>
                  {t('stockIn.batchExpiry')}{' '}
                  <strong className="text-amber-300 font-mono">{successResult.batch.expiryDate}</strong>
                </span>
              </div>
            )}
          </div>
        ) : (
          /* Form Controls */
          <form onSubmit={handleSubmit} className="space-y-4">
            {errorMsg && (
              <ErrorMessage
                variant="error"
                message={errorMsg}
                onDismiss={() => setErrorMsg(null)}
              />
            )}

            {packagings.length > 0 && (
              <div className="space-y-2">
                <span className="text-xs font-semibold text-zinc-300 block">{t('stockIn.receivingAs')}</span>
                <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t('stockIn.receivingAs')}>
                  {[null, ...packagings].map((p) => {
                    const active = (p?.id ?? null) === selectedPackagingId;
                    return (
                      <button
                        key={p?.id ?? 'single'}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        onClick={() => selectPackaging(p)}
                        className={`px-3 py-2 rounded-xl text-xs font-semibold border transition-colors ${
                          active
                            ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50'
                            : 'bg-zinc-900 text-zinc-300 border-zinc-800 hover:bg-zinc-800'
                        }`}
                      >
                        {p ? packagingLabel(p, t) : t('stockIn.singleUnits')}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Quantity Input with Mobile Quick Steppers */}
            <div className="space-y-2">
              <label className="text-xs font-semibold text-zinc-300 block">
                {selectedPackaging
                  ? t('stockIn.packagesLabel', { pack: packagingLabel(selectedPackaging, t) })
                  : t('stockIn.quantityLabel')}{' '}
                <span className="text-emerald-400">*</span>
              </label>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleQuickAdd(-1)}
                  className="w-12 h-12 bg-zinc-900 hover:bg-zinc-800 active:bg-zinc-700 text-zinc-200 rounded-xl border border-zinc-800 flex items-center justify-center font-bold text-lg select-none"
                  aria-label={t('stockIn.decrease')}
                >
                  <Minus className="w-5 h-5" />
                </button>

                <input
                  type="number"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  min="1"
                  step="1"
                  value={quantityInput}
                  onChange={(e) => {
                    setQuantityInput(e.target.value);
                    if (errorMsg) setErrorMsg(null);
                  }}
                  className="flex-1 h-12 bg-zinc-900 border border-zinc-800 rounded-xl text-center font-extrabold text-xl text-zinc-100 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 min-w-0"
                  required
                />

                <button
                  type="button"
                  onClick={() => handleQuickAdd(1)}
                  className="w-12 h-12 bg-zinc-900 hover:bg-zinc-800 active:bg-zinc-700 text-zinc-200 rounded-xl border border-zinc-800 flex items-center justify-center font-bold text-lg select-none"
                  aria-label={t('stockIn.increase')}
                >
                  <Plus className="w-5 h-5" />
                </button>
              </div>

              {selectedPackaging && (
                <p className="text-xs font-semibold text-emerald-300" data-testid="units-preview">
                  {t('stockIn.equalsUnits', { count: unitsToAdd })}
                </p>
              )}

              {/* Fast spaza presets (+5, +10, +24 crate) */}
              <div className="grid grid-cols-4 gap-2 pt-1">
                {(selectedPackaging ? [1, 2, 5, 10] : [5, 10, 12, 24]).map((amount) => (
                  <button
                    key={amount}
                    type="button"
                    onClick={() => handleSetQuantity(amount)}
                    className="py-1.5 px-2 bg-zinc-900/90 hover:bg-zinc-800 active:bg-zinc-700 text-xs font-semibold text-zinc-300 rounded-lg border border-zinc-800/80 transition-colors"
                  >
                    +{amount}
                  </button>
                ))}
              </div>
            </div>

            {/* Batch Expiry Date Section */}
            <div className="p-3.5 bg-zinc-900/50 rounded-2xl border border-zinc-800/80 space-y-3">
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={hasExpiry}
                    onChange={(e) => setHasExpiry(e.target.checked)}
                    className="w-4 h-4 rounded text-emerald-600 bg-zinc-800 border-zinc-700 focus:ring-emerald-500 focus:ring-offset-zinc-900"
                  />
                  <span className="text-xs font-semibold text-zinc-200">
                    {t('stockIn.hasExpiryToggle')}
                  </span>
                </label>
                <span className="text-[10px] text-zinc-400">
                  {hasExpiry ? t('stockIn.perishable') : t('stockIn.nonPerishable')}
                </span>
              </div>

              {hasExpiry && (
                <div className="space-y-2 pt-1 animate-in fade-in">
                  <Input
                    type="date"
                    value={expiryDate}
                    onChange={(e) => {
                      setExpiryDate(e.target.value);
                      if (errorMsg) setErrorMsg(null);
                    }}
                    leftIcon={<Calendar className="w-4 h-4 text-amber-500" />}
                    required={hasExpiry}
                  />

                  {/* Expiry Presets (+5 days, +7 days, +30 days, +90 days) */}
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {[
                      { label: t('stockIn.presetBread'), days: 5 },
                      { label: t('stockIn.presetMilk'), days: 10 },
                      { label: t('stockIn.presetMonths', { count: 1 }), days: 30 },
                      { label: t('stockIn.presetMonths', { count: 3 }), days: 90 },
                      { label: t('stockIn.presetMonths', { count: 6 }), days: 180 },
                    ].map((preset) => (
                      <button
                        key={preset.label}
                        type="button"
                        onClick={() => setExpiryDate(getPresetDate(preset.days))}
                        className={`text-[10px] font-medium px-2.5 py-1 rounded-lg border transition-colors ${
                          expiryDate === getPresetDate(preset.days)
                            ? 'bg-amber-500/20 text-amber-300 border-amber-500/40 font-bold'
                            : 'bg-zinc-800/60 text-zinc-400 border-zinc-700/50 hover:bg-zinc-800 hover:text-zinc-200'
                        }`}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>

                  <p className="text-[11px] text-zinc-400 leading-tight">
                    {t('stockIn.expiryHelp')}
                  </p>
                </div>
              )}
            </div>

            {/* Optional Unit Cost Override */}
            <Input
              label={
                selectedPackaging
                  ? t('stockIn.costPerPackage', { pack: packagingLabel(selectedPackaging, t) })
                  : t('stockIn.costPricePerUnit')
              }
              placeholder="0.00"
              type="number"
              step="0.01"
              min="0"
              inputMode="decimal"
              value={costPrice}
              onChange={(e) => setCostPrice(e.target.value)}
              leftIcon={<span className="text-xs font-bold text-zinc-400">R</span>}
              helperText={
                selectedPackaging && costPrice.trim() && !isNaN(parseFloat(costPrice))
                  ? t('stockIn.costPerUnitPreview', {
                      amount: toCents(parseFloat(costPrice) / unitsPerPackage).toFixed(2),
                    })
                  : t('stockIn.costHelp')
              }
            />

            <Input
              label={t('stockIn.lotNumber')}
              placeholder={t('stockIn.lotPlaceholder')}
              value={lotNumber}
              maxLength={40}
              onChange={(e) => setLotNumber(e.target.value)}
            />
            <Input
              label={t('stockIn.supplier')}
              placeholder={t('stockIn.supplierPlaceholder')}
              value={supplierName}
              maxLength={80}
              onChange={(e) => setSupplierName(e.target.value)}
            />
          </form>
        )}
      </div>
    </Dialog>
  );
};
