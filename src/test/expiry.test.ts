import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  alertDedupKey,
  batchCode,
  daysUntil,
  normalizeReminderDays,
  reminderStage,
  todayInZone,
} from '../lib/expiry';
import { saveShopSettings, sanitizeShopSettings } from '../lib/shopSettings';
import { db, resetLocalDatabase } from '../lib/db';
import { createProduct } from '../services/productService';
import {
  batchExpiryChanges,
  getExpiryAlerts,
  getProductTotalStock,
  resolveExpiredBatch,
  stockIn,
} from '../services/stockService';
import { recordSale } from '../services/salesService';
import { takeUnnotifiedAlerts } from '../services/alertNotifier';
import type { Product, StockBatch } from '../types';
import { SHOP_ID } from './helpers';

const SAST = 'Africa/Johannesburg';

describe('todayInZone', () => {
  it('rolls over at local midnight, not UTC midnight', () => {
    expect(todayInZone(SAST, new Date('2026-10-14T21:59:59Z'))).toBe('2026-10-14');
    expect(todayInZone(SAST, new Date('2026-10-14T22:00:00Z'))).toBe('2026-10-15');
    expect(todayInZone('UTC', new Date('2026-10-14T22:00:00Z'))).toBe('2026-10-14');
  });

  it('handles zones far from UTC', () => {
    expect(todayInZone('Pacific/Kiritimati', new Date('2026-10-14T10:00:00Z'))).toBe('2026-10-15');
    expect(todayInZone('Pacific/Pago_Pago', new Date('2026-10-14T10:00:00Z'))).toBe('2026-10-13');
  });

  it('handles daylight-saving changes', () => {
    // New York leaves DST at 06:00 UTC on 2026-11-01 (02:00 EDT becomes 01:00 EST).
    expect(todayInZone('America/New_York', new Date('2026-11-01T03:59:00Z'))).toBe('2026-10-31');
    expect(todayInZone('America/New_York', new Date('2026-11-01T04:00:00Z'))).toBe('2026-11-01');
    expect(todayInZone('America/New_York', new Date('2026-11-02T04:59:00Z'))).toBe('2026-11-01');
    expect(todayInZone('America/New_York', new Date('2026-11-02T05:00:00Z'))).toBe('2026-11-02');
    expect(daysUntil('2026-11-02', '2026-10-31')).toBe(2);
    expect(daysUntil('2026-03-30', '2026-03-28')).toBe(2);
  });

  it('falls back to the default zone for an unknown one', () => {
    expect(todayInZone('Mars/Olympus', new Date('2026-10-14T22:30:00Z'))).toBe('2026-10-15');
  });
});

describe('reminderStage', () => {
  const today = '2026-10-14';
  const at = (days: number) => {
    const d = new Date(Date.UTC(2026, 9, 14 + days));
    return d.toISOString().slice(0, 10);
  };

  it('picks the smallest threshold that covers the days left', () => {
    const cases: Array<[number, number | null]> = [
      [22, null],
      [21, 21],
      [15, 21],
      [14, 14],
      [13, 14],
      [8, 14],
      [7, 7],
      [1, 7],
      [0, 7],
    ];
    for (const [days, threshold] of cases) {
      const stage = reminderStage(at(days), today, [21, 14, 7]);
      expect(stage === null ? null : stage.threshold, `${days} days left`).toBe(threshold);
    }
  });

  it('switches to a single overdue alert the day after expiry', () => {
    expect(reminderStage(at(-1), today, [21, 14, 7])).toEqual({ kind: 'expired', threshold: null });
    expect(reminderStage(at(-40), today, [21, 14, 7])).toEqual({ kind: 'expired', threshold: null });
    expect(reminderStage(null, today, [21, 14, 7])).toBeNull();
  });

  it('follows custom reminder days', () => {
    expect(reminderStage(at(10), today, [30, 3])).toEqual({ kind: 'reminder', threshold: 30 });
    expect(reminderStage(at(2), today, [30, 3])).toEqual({ kind: 'reminder', threshold: 3 });
    expect(reminderStage(at(31), today, [30, 3])).toBeNull();
  });

  it('builds the same dedup key as the server', () => {
    const id = 'abcdef12-0000-4000-8000-000000000000';
    expect(alertDedupKey(id, '2026-10-20', { kind: 'reminder', threshold: 7 })).toBe(`${id}:2026-10-20:reminder:7`);
    expect(alertDedupKey(id, '2026-10-20', { kind: 'expired', threshold: null })).toBe(`${id}:2026-10-20:expired:`);
    expect(batchCode(id)).toBe('ABCDEF');
  });
});

describe('reminder settings', () => {
  it('normalises valid lists and rejects invalid ones', () => {
    expect(normalizeReminderDays([7, 21, 14, 7])).toEqual([21, 14, 7]);
    expect(normalizeReminderDays([180, 1])).toEqual([180, 1]);
    expect(normalizeReminderDays([])).toBeNull();
    expect(normalizeReminderDays([0])).toBeNull();
    expect(normalizeReminderDays([181])).toBeNull();
    expect(normalizeReminderDays([1.5])).toBeNull();
    expect(normalizeReminderDays([1, 2, 3, 4, 5, 6])).toBeNull();
  });

  it('sanitises cached settings', () => {
    const s = sanitizeShopSettings({ timezone: 'Nope/Nowhere', reminderDays: [0], role: 'boss' as never });
    expect(s.reminderDays).toEqual([21, 14, 7]);
    expect(s.role).toBe('owner');
    expect(s.timezone).not.toBe('Nope/Nowhere');
  });
});

describe('batchExpiryChanges', () => {
  const batch = (id: string, expiryDate: string | null): StockBatch => ({
    id,
    shopId: SHOP_ID,
    productId: 'p',
    quantity: 1,
    initialQuantity: 1,
    expiryDate,
    receivedAt: '2026-10-01T08:00:00Z',
  });

  it('returns only the dates that changed', () => {
    const batches = [batch('a', '2026-11-01'), batch('b', null), batch('c', '2026-12-01')];
    expect(batchExpiryChanges(batches, {})).toEqual({ changes: [], invalid: [] });
    expect(batchExpiryChanges(batches, { a: '2026-11-01', b: '', c: ' 2027-01-15 ' })).toEqual({
      changes: [{ batchId: 'c', expiryDate: '2027-01-15' }],
      invalid: [],
    });
    expect(batchExpiryChanges(batches, { b: '2026-10-30' }).changes).toEqual([{ batchId: 'b', expiryDate: '2026-10-30' }]);
  });

  it('refuses removing a date or an impossible date', () => {
    const batches = [batch('a', '2026-11-01'), batch('b', null)];
    expect(batchExpiryChanges(batches, { a: '', b: '2026-02-30' })).toEqual({ changes: [], invalid: ['a', 'b'] });
  });
});

describe('expired stock on this phone', () => {
  let product: Product;

  beforeEach(async () => {
    await resetLocalDatabase();
    await saveShopSettings(SHOP_ID, { timezone: SAST, reminderDays: [21, 14, 7], role: 'owner' });
    const created = await createProduct({ barcode: '6001007300999', name: 'Milk', category: 'dairy', sellingPrice: 20 }, SHOP_ID);
    product = created.product!;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sells a batch on its expiry day and refuses it from the next shop-local day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await stockIn({ productId: product.id, quantity: 5, expiryDate: '2026-10-14' }, SHOP_ID);
    await stockIn({ productId: product.id, quantity: 2, expiryDate: '2026-12-01' }, SHOP_ID);

    vi.setSystemTime(new Date('2026-10-14T21:59:00Z'));
    expect(await getProductTotalStock(product.id, SHOP_ID)).toBe(7);

    vi.setSystemTime(new Date('2026-10-14T22:00:00Z'));
    expect(await getProductTotalStock(product.id, SHOP_ID)).toBe(2);
    const refused = await recordSale({ productId: product.id, quantity: 3 }, SHOP_ID);
    expect(refused).toMatchObject({ errorCode: 'insufficient_stock', available: 2, expired: 5 });

    const sold = await recordSale({ productId: product.id, quantity: 2 }, SHOP_ID);
    expect(sold.result?.allocations.map((a) => a.batchExpiryDate)).toEqual(['2026-12-01']);
    const expired = (await db.batches.toArray()).find((b) => b.expiryDate === '2026-10-14');
    expect(expired?.quantity).toBe(5);
  });

  it('discards expired stock with a write-off, keeps the record queued and clears the alert', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-14T08:00:00Z'));
    const { result } = await stockIn({ productId: product.id, quantity: 4, expiryDate: '2026-10-10' }, SHOP_ID);
    const batchId = result!.batch.id;

    expect((await getExpiryAlerts(SHOP_ID)).map((a) => a.kind)).toEqual(['expired']);

    const outcome = await resolveExpiredBatch({ batchId, action: 'discarded', idempotencyKey: 'k1' }, SHOP_ID);
    expect(outcome.result).toMatchObject({ removed: 4, batch: { quantity: 0 } });
    expect(await getExpiryAlerts(SHOP_ID)).toEqual([]);

    const movement = (await db.movements.toArray()).find((m) => m.batchId === batchId && m.type !== 'stock_in');
    expect(movement).toMatchObject({ type: 'write_off_expired', quantityDelta: -4, idempotencyKey: 'expiry:k1' });
    const queued = await db.outbox.orderBy('seq').last();
    expect(queued).toMatchObject({ type: 'expiry_resolve', payload: { batchId, action: 'discarded', idempotencyKey: 'k1' } });

    const again = await resolveExpiredBatch({ batchId, action: 'discarded', idempotencyKey: 'k1' }, SHOP_ID);
    expect(again.errorCode).toBe('duplicate');
    const empty = await resolveExpiredBatch({ batchId, action: 'returned_to_supplier', idempotencyKey: 'k2' }, SHOP_ID);
    expect(empty.errorCode).toBe('empty');
  });

  it('corrects a wrong expiry date without moving stock', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-14T08:00:00Z'));
    const { result } = await stockIn({ productId: product.id, quantity: 3, expiryDate: '2026-10-01' }, SHOP_ID);
    const batchId = result!.batch.id;
    const movementsBefore = await db.movements.count();

    expect((await resolveExpiredBatch({ batchId, action: 'expiry_corrected' }, SHOP_ID)).errorCode).toBe('invalid');
    const outcome = await resolveExpiredBatch(
      { batchId, action: 'expiry_corrected', newExpiryDate: '2027-01-31', note: 'Misread label' },
      SHOP_ID
    );
    expect(outcome.result?.batch).toMatchObject({ quantity: 3, expiryDate: '2027-01-31' });
    expect(await db.movements.count()).toBe(movementsBefore);
    expect(await getProductTotalStock(product.id, SHOP_ID)).toBe(3);
  });

  it('moves a date that has not expired yet and adds a missing one, as the edit dialog does', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-14T08:00:00Z'));
    const soon = (await stockIn({ productId: product.id, quantity: 3, expiryDate: '2026-10-18' }, SHOP_ID)).result!.batch;
    const undated = (await stockIn({ productId: product.id, quantity: 2 }, SHOP_ID)).result!.batch;
    expect((await getExpiryAlerts(SHOP_ID)).map((a) => a.batch.id)).toEqual([soon.id]);

    const { changes } = batchExpiryChanges([soon, undated], { [soon.id]: '2027-02-01', [undated.id]: '2026-10-16' });
    for (const change of changes) {
      const outcome = await resolveExpiredBatch(
        { batchId: change.batchId, action: 'expiry_corrected', newExpiryDate: change.expiryDate },
        SHOP_ID
      );
      expect(outcome.result?.batch.expiryDate).toBe(change.expiryDate);
    }

    expect((await getExpiryAlerts(SHOP_ID)).map((a) => [a.batch.id, a.batch.expiryDate])).toEqual([
      [undated.id, '2026-10-16'],
    ]);
    const queued = (await db.outbox.toArray()).filter((item) => item.type === 'expiry_resolve');
    expect(queued.map((item) => item.payload)).toMatchObject([
      { batchId: soon.id, action: 'expiry_corrected', newExpiryDate: '2027-02-01' },
      { batchId: undated.id, action: 'expiry_corrected', newExpiryDate: '2026-10-16' },
    ]);
  });

  it('only lets owners and managers resolve expired stock', async () => {
    const { result } = await stockIn({ productId: product.id, quantity: 1, expiryDate: '2020-01-01' }, SHOP_ID);
    await saveShopSettings(SHOP_ID, { role: 'staff' });
    const outcome = await resolveExpiredBatch({ batchId: result!.batch.id, action: 'discarded' }, SHOP_ID);
    expect(outcome.errorCode).toBe('forbidden');
    expect((await db.batches.get(result!.batch.id))?.quantity).toBe(1);

    await saveShopSettings(SHOP_ID, { role: 'manager' });
    expect((await resolveExpiredBatch({ batchId: result!.batch.id, action: 'discarded' }, SHOP_ID)).result).toBeTruthy();
  });

  it('announces each alert once, and again only when it reaches a new threshold', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-14T08:00:00Z'));
    await stockIn({ productId: product.id, quantity: 6, expiryDate: '2026-10-30' }, SHOP_ID);

    const first = await getExpiryAlerts(SHOP_ID);
    expect(first.map((a) => a.thresholdDays)).toEqual([21]);
    expect(await takeUnnotifiedAlerts(SHOP_ID, first)).toHaveLength(1);
    expect(await takeUnnotifiedAlerts(SHOP_ID, first)).toHaveLength(0);

    const [a, b] = await Promise.all([takeUnnotifiedAlerts(SHOP_ID, first), takeUnnotifiedAlerts(SHOP_ID, first)]);
    expect(a.length + b.length).toBe(0);

    vi.setSystemTime(new Date('2026-10-16T08:00:00Z'));
    const second = await getExpiryAlerts(SHOP_ID);
    expect(second.map((x) => x.thresholdDays)).toEqual([14]);
    expect(await takeUnnotifiedAlerts(SHOP_ID, second)).toHaveLength(1);
  });

  it('announces a new alert to only one of two overlapping refreshes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-14T08:00:00Z'));
    await stockIn({ productId: product.id, quantity: 6, expiryDate: '2026-10-16' }, SHOP_ID);
    const items = await getExpiryAlerts(SHOP_ID);
    const [a, b] = await Promise.all([takeUnnotifiedAlerts(SHOP_ID, items), takeUnnotifiedAlerts(SHOP_ID, items)]);
    expect(a.length + b.length).toBe(1);
  });
});
