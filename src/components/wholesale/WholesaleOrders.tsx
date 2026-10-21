import React, { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, Truck } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { db } from '../../lib/db';
import { onDataChanged } from '../../lib/events';
import { isBatchExpired, todayInZone } from '../../lib/expiry';
import { whatsappShareUrl } from '../../lib/invite';
import { newId } from '../../lib/ids';
import { parseMinStock } from '../../lib/lowStock';
import { formatRand, lineTotal, orderSummaryText, parseEstimatedCost, suggestedOrderLines } from '../../lib/wholesaleOrders';
import {
  archiveWholesaler,
  saveWholesaleOrder,
  setWholesaleItemPurchased,
  setWholesaleOrderStatus,
  upsertWholesaler,
} from '../../services/wholesaleService';
import type { Product, StockBatch, Wholesaler, WholesaleOrder, WholesaleOrderItem, WholesaleOrderStatus } from '../../types';
import { Button } from '../ui/Button';

export interface WholesaleOrdersProps {
  shopId: string;
  canManage: boolean;
  products: Product[];
  batches: StockBatch[];
  timezone: string;
  onClose: () => void;
}

interface DraftLine {
  id: string;
  productId: string;
  quantity: string;
  cost: string;
  purchased: boolean;
  purchasedAt: string | null;
}

interface EditorState {
  id: string;
  wholesalerId: string;
  note: string;
  status: WholesaleOrderStatus;
  lines: DraftLine[];
  createdAt: string;
}

const NEXT_STATUS: Partial<Record<WholesaleOrderStatus, Array<{ status: WholesaleOrderStatus; label: string }>>> = {
  draft: [
    { status: 'approved', label: 'wholesale.approve' },
    { status: 'cancelled', label: 'wholesale.cancelOrder' },
  ],
  approved: [
    { status: 'ordered', label: 'wholesale.markOrdered' },
    { status: 'draft', label: 'wholesale.reopen' },
    { status: 'cancelled', label: 'wholesale.cancelOrder' },
  ],
  ordered: [
    { status: 'partially_received', label: 'wholesale.markPartial' },
    { status: 'received', label: 'wholesale.markReceived' },
    { status: 'cancelled', label: 'wholesale.cancelOrder' },
  ],
  partially_received: [
    { status: 'received', label: 'wholesale.markReceived' },
    { status: 'cancelled', label: 'wholesale.cancelOrder' },
  ],
};

const STATUS_LABEL: Record<WholesaleOrderStatus, string> = {
  draft: 'wholesale.statusDraft',
  approved: 'wholesale.statusApproved',
  ordered: 'wholesale.statusOrdered',
  partially_received: 'wholesale.statusPartial',
  received: 'wholesale.statusReceived',
  cancelled: 'wholesale.statusCancelled',
};

function sellableUnits(productId: string, batches: StockBatch[], today: string): number {
  return batches
    .filter((batch) => batch.productId === productId && batch.quantity > 0 && !isBatchExpired(batch, today))
    .reduce((sum, batch) => sum + batch.quantity, 0);
}

const fieldClass = 'w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-3 text-sm text-zinc-100';

export const WholesaleOrders: React.FC<WholesaleOrdersProps> = ({
  shopId,
  canManage,
  products,
  batches,
  timezone,
  onClose,
}) => {
  const { t } = useLanguage();
  const today = useMemo(() => todayInZone(timezone), [timezone]);
  const [wholesalers, setWholesalers] = useState<Wholesaler[]>([]);
  const [orders, setOrders] = useState<WholesaleOrder[]>([]);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [form, setForm] = useState<{ id?: string; name: string; phone: string; note: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const [people, rows] = await Promise.all([
        db.wholesalers.where('shopId').equals(shopId).toArray(),
        db.wholesaleOrders.where('shopId').equals(shopId).toArray(),
      ]);
      if (cancelled) return;
      rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      setWholesalers(people);
      setOrders(rows);
    };
    void load();
    const stop = onDataChanged(() => {
      void load();
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, [shopId]);

  const activeWholesalers = wholesalers.filter((row) => !row.archivedAt).sort((a, b) => a.name.localeCompare(b.name));
  const productName = new Map(products.map((product) => [product.id, product.name]));
  const suggestions = useMemo(
    () =>
      suggestedOrderLines(
        products.map((product) => ({
          ...product,
          sellable: sellableUnits(product.id, batches, today),
        }))
      ),
    [products, batches, today]
  );

  const openNew = () => {
    setError(null);
    setEditor({
      id: newId(),
      wholesalerId: '',
      note: '',
      status: 'draft',
      createdAt: new Date().toISOString(),
      lines: suggestions.map((line) => ({
        id: newId(),
        productId: line.productId,
        quantity: String(line.quantity),
        cost: '',
        purchased: false,
        purchasedAt: null,
      })),
    });
  };

  const openExisting = async (order: WholesaleOrder) => {
    const items = await db.wholesaleOrderItems.where('orderId').equals(order.id).toArray();
    setError(null);
    setEditor({
      id: order.id,
      wholesalerId: order.wholesalerId ?? '',
      note: order.note ?? '',
      status: order.status,
      createdAt: order.createdAt,
      lines: items.map((item) => ({
        id: item.id,
        productId: item.productId,
        quantity: String(item.quantity),
        cost: item.estimatedUnitCost == null ? '' : String(item.estimatedUnitCost),
        purchased: item.purchasedAt != null,
        purchasedAt: item.purchasedAt ?? null,
      })),
    });
  };

  const savePerson = async () => {
    if (!form || !canManage) return;
    setSaving(true);
    setError(null);
    try {
      const result = await upsertWholesaler(shopId, form);
      if (!result.value) {
        setError(result.errorCode === 'invalid' ? t('wholesale.nameInvalid') : result.error ?? t('errors.generic'));
        return;
      }
      setWholesalers((current) => {
        const rest = current.filter((row) => row.id !== result.value!.id);
        return [...rest, result.value!];
      });
      setForm(null);
      setNotice(t('wholesale.saved'));
    } finally {
      setSaving(false);
    }
  };

  const archivePerson = async (id: string) => {
    if (!canManage) return;
    const result = await archiveWholesaler(shopId, id);
    if (!result.value) {
      setError(result.error ?? t('errors.generic'));
      return;
    }
    setWholesalers((current) => current.map((row) => (row.id === id ? result.value! : row)));
  };

  const parsedLines = (lines: DraftLine[]): WholesaleOrderItem[] | 'quantity' | 'cost' => {
    const items: WholesaleOrderItem[] = [];
    for (const line of lines) {
      const quantity = parseMinStock(line.quantity);
      if (quantity === 'invalid' || quantity === null || quantity < 1) return 'quantity';
      const cost = parseEstimatedCost(line.cost);
      if (cost === 'invalid') return 'cost';
      items.push({
        id: line.id,
        shopId,
        orderId: editor!.id,
        productId: line.productId,
        quantity,
        estimatedUnitCost: cost,
        purchasedAt: line.purchased ? line.purchasedAt ?? new Date().toISOString() : null,
        updatedAt: new Date().toISOString(),
      });
    }
    return items;
  };

  const persistDraft = async (state: EditorState): Promise<WholesaleOrder | null> => {
    const items = parsedLines(state.lines);
    if (items === 'quantity' || items === 'cost') {
      setError(items === 'cost' ? t('wholesale.costInvalid') : t('intelligence.minStockInvalid'));
      return null;
    }
    const order: WholesaleOrder = {
      id: state.id,
      shopId,
      wholesalerId: state.wholesalerId || null,
      status: 'draft',
      note: state.note.trim() || null,
      createdAt: state.createdAt,
      updatedAt: new Date().toISOString(),
    };
    const result = await saveWholesaleOrder(shopId, order, items);
    if (!result.value) {
      setError(result.error ?? t('errors.generic'));
      return null;
    }
    return result.value.order;
  };

  const changeStatus = async (status: WholesaleOrderStatus) => {
    if (!editor || !canManage || saving) return;
    setSaving(true);
    setError(null);
    try {
      let orderId = editor.id;
      if (editor.status === 'draft') {
        if (status !== 'cancelled' && status !== 'draft') {
          const items = parsedLines(editor.lines);
          if (items === 'quantity' || items === 'cost') {
            setError(items === 'cost' ? t('wholesale.costInvalid') : t('intelligence.minStockInvalid'));
            return;
          }
          if (!editor.wholesalerId || items.length === 0) {
            setError(t('wholesale.needLines'));
            return;
          }
        }
        if (status === 'cancelled' && editor.lines.length === 0 && !editor.wholesalerId) {
          setEditor(null);
          return;
        }
        const saved = await persistDraft(editor);
        if (!saved) return;
        orderId = saved.id;
      }
      if (status === 'draft' && editor.status === 'draft') {
        setNotice(t('wholesale.saved'));
        setEditor(null);
        return;
      }
      const result = await setWholesaleOrderStatus(shopId, orderId, status);
      if (!result.value) {
        setError(result.errorCode === 'invalid' ? t('wholesale.needLines') : result.error ?? t('errors.generic'));
        return;
      }
      setOrders((current) => {
        const rest = current.filter((row) => row.id !== result.value!.id);
        return [result.value!, ...rest];
      });
      setNotice(t('wholesale.saved'));
      setEditor(null);
    } finally {
      setSaving(false);
    }
  };

  const addProduct = (productId: string) => {
    if (!editor || !productId) return;
    setEditor({
      ...editor,
      lines: [...editor.lines, { id: newId(), productId, quantity: '1', cost: '', purchased: false, purchasedAt: null }],
    });
  };

  const togglePurchased = async (line: DraftLine) => {
    if (!editor || !canManage || editor.status === 'cancelled' || saving) return;
    const next = !line.purchased;
    const purchasedAt = next ? line.purchasedAt ?? new Date().toISOString() : null;
    const lines = editor.lines.map((row) => (row.id === line.id ? { ...row, purchased: next, purchasedAt } : row));
    setSaving(true);
    setError(null);
    try {
      if (editor.status === 'draft') {
        const saved = await persistDraft({ ...editor, lines });
        if (!saved) return;
      }
      const result = await setWholesaleItemPurchased(shopId, line.id, next);
      if (!result.value) {
        setError(result.error ?? t('errors.generic'));
        return;
      }
      setEditor({
        ...editor,
        lines: lines.map((row) => (row.id === line.id ? { ...row, purchasedAt: result.value?.purchasedAt ?? null, purchased: next } : row)),
      });
    } finally {
      setSaving(false);
    }
  };

  if (editor) {
    const editable = canManage && editor.status === 'draft';
    const summaryLines = editor.lines.flatMap((line) => {
      const quantity = parseMinStock(line.quantity);
      const cost = parseEstimatedCost(line.cost);
      if (quantity === 'invalid' || quantity === null || quantity < 1) return [];
      return [{
        name: productName.get(line.productId) ?? line.productId,
        quantity,
        unitCost: cost === 'invalid' ? null : cost,
        purchased: line.purchased,
      }];
    });
    const wholesalerName = activeWholesalers.find((row) => row.id === editor.wholesalerId)?.name ?? t('wholesale.noWholesaler');
    const summary = orderSummaryText(wholesalerName, summaryLines, {
      purchased: t('wholesale.purchased'),
      total: t('wholesale.estimatedTotal'),
    });
    const available = products.filter(
      (product) => !product.archivedAt && product.listed !== false && !editor.lines.some((line) => line.productId === product.id)
    );
    return (
      <div className="space-y-4 pb-24" data-testid="wholesale-order">
        <button type="button" onClick={() => setEditor(null)} className="inline-flex items-center gap-1 text-sm text-zinc-300">
          <ChevronLeft className="w-4 h-4" />
          {t('wholesale.close')}
        </button>
        <h2 className="text-lg font-bold text-zinc-100">{t(STATUS_LABEL[editor.status])}</h2>
        {suggestions.length > 0 && editor.status === 'draft' && (
          <p className="text-xs text-zinc-400">{t('wholesale.suggestions')}</p>
        )}
        <label className="block text-xs text-zinc-300">
          {t('wholesale.chooseWholesaler')}
          <select
            aria-label={t('wholesale.chooseWholesaler')}
            value={editor.wholesalerId}
            disabled={!editable}
            onChange={(event) => setEditor({ ...editor, wholesalerId: event.target.value })}
            className={`${fieldClass} mt-1`}
          >
            <option value="">{t('wholesale.noWholesaler')}</option>
            {activeWholesalers.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </select>
        </label>
        <ul className="space-y-2">
          {editor.lines.map((line) => {
            const name = productName.get(line.productId) ?? line.productId;
            const quantity = parseMinStock(line.quantity);
            const cost = parseEstimatedCost(line.cost);
            const total = typeof quantity === 'number' && cost !== 'invalid' ? lineTotal(quantity, cost) : null;
            return (
            <li key={line.id} className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-semibold text-zinc-100">{name}</p>
                {editable && (
                  <Button type="button" size="sm" variant="ghost" onClick={() => setEditor({ ...editor, lines: editor.lines.filter((row) => row.id !== line.id) })}>
                    {t('wholesale.remove')}
                  </Button>
                )}
              </div>
              <label className="mt-2 block text-xs text-zinc-400">
                {t('wholesale.quantity')}
                <input
                  inputMode="numeric"
                  aria-label={`${name} ${t('wholesale.quantity')}`}
                  value={line.quantity}
                  disabled={!editable}
                  onChange={(event) =>
                    setEditor({
                      ...editor,
                      lines: editor.lines.map((row) => (row.id === line.id ? { ...row, quantity: event.target.value } : row)),
                    })
                  }
                  className={`${fieldClass} mt-1`}
                />
              </label>
              <label className="mt-2 block text-xs text-zinc-400">
                {t('wholesale.unitCost')}
                <input
                  inputMode="decimal"
                  aria-label={`${name} ${t('wholesale.unitCost')}`}
                  value={line.cost}
                  disabled={!editable}
                  onChange={(event) =>
                    setEditor({
                      ...editor,
                      lines: editor.lines.map((row) => (row.id === line.id ? { ...row, cost: event.target.value } : row)),
                    })
                  }
                  className={`${fieldClass} mt-1`}
                />
              </label>
              {total != null && <p className="mt-1 text-xs text-zinc-300">= {formatRand(total)}</p>}
              {editor.status !== 'cancelled' && (
                <label className="mt-2 flex items-center gap-2 text-xs text-zinc-300">
                  <input
                    type="checkbox"
                    aria-label={`${name} ${t('wholesale.purchased')}`}
                    checked={line.purchased}
                    disabled={!canManage || saving}
                    onChange={() => void togglePurchased(line)}
                  />
                  {t('wholesale.purchased')}
                </label>
              )}
            </li>
            );
          })}
        </ul>
        {summaryLines.length > 0 && (
          <div className="space-y-2">
            <p className="whitespace-pre-wrap text-sm text-zinc-200" data-testid="order-summary">{summary}</p>
            <a href={whatsappShareUrl(summary)} target="_blank" rel="noopener noreferrer" className="inline-flex text-sm font-semibold text-emerald-300">
              {t('intelligence.sendOrder')}
            </a>
          </div>
        )}
        {editable && (
          <label className="block text-xs text-zinc-300">
            {t('wholesale.addProduct')}
            <select
              aria-label={t('wholesale.addProduct')}
              value=""
              onChange={(event) => addProduct(event.target.value)}
              className={`${fieldClass} mt-1`}
            >
              <option value="">{available.length === 0 ? t('wholesale.noProducts') : t('wholesale.addProduct')}</option>
              {available.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {error && <p className="text-xs text-rose-300">{error}</p>}
        {canManage && (
          <div className="flex flex-col gap-2">
            {editor.status === 'draft' && (
              <Button type="button" variant="outline" disabled={saving} onClick={() => void changeStatus('draft')}>
                {t('wholesale.save')}
              </Button>
            )}
            {(NEXT_STATUS[editor.status] ?? []).map((action) => (
              <Button key={action.status} type="button" disabled={saving} onClick={() => void changeStatus(action.status)}>
                {t(action.label)}
              </Button>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-5 pb-24" data-testid="wholesale-home">
      <button type="button" onClick={onClose} className="inline-flex items-center gap-1 text-sm text-zinc-300">
        <ChevronLeft className="w-4 h-4" />
        {t('wholesale.close')}
      </button>
      <h2 className="text-lg font-bold text-zinc-100 flex items-center gap-2">
        <Truck className="w-5 h-5 text-zinc-400" />
        {t('wholesale.title')}
      </h2>
      {!canManage && <p className="text-xs text-zinc-500">{t('wholesale.readOnly')}</p>}
      {notice && <p className="text-xs text-emerald-400">{notice}</p>}
      {error && <p className="text-xs text-rose-300">{error}</p>}

      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-zinc-100">{t('wholesale.wholesalersTitle')}</h3>
          {canManage && (
            <Button type="button" size="sm" variant="outline" onClick={() => setForm({ name: '', phone: '', note: '' })}>
              {t('wholesale.addWholesaler')}
            </Button>
          )}
        </div>
        {form && (
          <div className="space-y-2 rounded-xl border border-zinc-800 p-3">
            <input aria-label={t('wholesale.name')} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder={t('wholesale.name')} className={fieldClass} />
            <input aria-label={t('wholesale.phone')} value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} placeholder={t('wholesale.phone')} className={fieldClass} />
            <input aria-label={t('wholesale.note')} value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} placeholder={t('wholesale.note')} className={fieldClass} />
            <Button type="button" disabled={saving} onClick={() => void savePerson()}>
              {t('wholesale.save')}
            </Button>
          </div>
        )}
        {activeWholesalers.length === 0 ? (
          <p className="text-xs text-zinc-500">{t('wholesale.emptyWholesalers')}</p>
        ) : (
          <ul className="space-y-2">
            {activeWholesalers.map((row) => (
              <li key={row.id} className="flex items-center justify-between gap-2 rounded-xl border border-zinc-800 px-3 py-2">
                <span className="text-sm text-zinc-100">{row.name}</span>
                {canManage && (
                  <span className="flex gap-2">
                    <Button type="button" size="sm" variant="ghost" onClick={() => setForm({ id: row.id, name: row.name, phone: row.phone ?? '', note: row.note ?? '' })}>
                      {t('wholesale.editWholesaler')}
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => void archivePerson(row.id)}>
                      {t('wholesale.archive')}
                    </Button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-zinc-100">{t('wholesale.ordersTitle')}</h3>
          {canManage && (
            <Button type="button" size="sm" onClick={openNew}>
              {t('wholesale.newOrder')}
            </Button>
          )}
        </div>
        {orders.length === 0 ? (
          <p className="text-xs text-zinc-500">{t('wholesale.emptyOrders')}</p>
        ) : (
          <ul className="space-y-2">
            {orders.map((order) => {
              const person = wholesalers.find((row) => row.id === order.wholesalerId);
              return (
                <li key={order.id}>
                  <button type="button" onClick={() => void openExisting(order)} className="w-full rounded-xl border border-zinc-800 px-3 py-3 text-left">
                    <span className="block text-sm font-semibold text-zinc-100">{person?.name ?? t('wholesale.noWholesaler')}</span>
                    <span className="block text-xs text-zinc-400">{t(STATUS_LABEL[order.status])}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
};
