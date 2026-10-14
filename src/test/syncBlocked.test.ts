import { describe, it, expect, beforeEach } from 'vitest';
import { BLOCKED_RETRY_MS, blockedReason, isPermanentError, pushOutbox, reportSyncFailures } from '../sync/syncEngine';
import { createProduct } from '../services/productService';
import { stockIn } from '../services/stockService';
import { db, resetLocalDatabase } from '../lib/db';
import { createFakeSupabase, SHOP_ID } from './helpers';

async function queueTwoChanges(): Promise<void> {
  const { product } = await createProduct(
    { barcode: '6001087361250', name: 'Simba Chips', category: 'snacks', sellingPrice: 15 },
    SHOP_ID
  );
  await stockIn({ productId: product!.id, quantity: 4 }, SHOP_ID);
}

describe('blocked sync', () => {
  beforeEach(async () => {
    await resetLocalDatabase();
  });

  it('recognises suspension and plan limits, and never treats them as permanent', () => {
    expect(blockedReason({ code: 'SP001' })).toBe('suspended');
    expect(blockedReason({ code: 'SP002' })).toBe('plan_limit');
    expect(blockedReason({ code: '42501' })).toBeNull();
    expect(isPermanentError({ code: 'SP001' })).toBe(false);
    expect(isPermanentError({ code: 'SP002' })).toBe(false);
  });

  it('holds the queue in order without counting attempts while the shop is suspended', async () => {
    await queueTwoChanges();
    const fake = createFakeSupabase({
      rpc: () => ({ data: null, error: { code: 'SP001', message: 'This shop is suspended.' } }),
    });

    const now = 1_000_000;
    const result = await pushOutbox(fake.client, SHOP_ID, now);
    expect(result).toEqual({ pushed: 0, failed: 0, retryAt: now + BLOCKED_RETRY_MS, blocked: 'suspended' });
    expect(fake.rpc).toHaveBeenCalledTimes(1);

    const items = await db.outbox.orderBy('seq').toArray();
    expect(items.map((i) => i.status)).toEqual(['pending', 'pending']);
    expect(items[0]).toMatchObject({ attempts: 0, nextAttemptAt: now + BLOCKED_RETRY_MS, blocked: 'suspended' });

    // Before the retry is due, the block is still reported and nothing is sent.
    const waiting = await pushOutbox(fake.client, SHOP_ID, now + 60_000);
    expect(waiting).toMatchObject({ pushed: 0, blocked: 'suspended' });
    expect(fake.rpc).toHaveBeenCalledTimes(1);

    // Many blocked rounds later the change is still waiting, never failed.
    for (let round = 1; round <= 10; round++) {
      await pushOutbox(fake.client, SHOP_ID, now + round * BLOCKED_RETRY_MS);
    }
    expect((await db.outbox.orderBy('seq').first())).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('sends everything once the shop is reactivated and clears the block', async () => {
    await queueTwoChanges();
    let suspended = true;
    const fake = createFakeSupabase({
      rpc: (name, args) =>
        suspended
          ? { data: null, error: { code: 'SP001', message: 'This shop is suspended.' } }
          : name === 'upsert_product'
            ? {
                data: {
                  id: args.p_id, shop_id: args.p_shop_id, barcode: args.p_barcode, name: args.p_name,
                  category: args.p_category, buying_price: null, selling_price: args.p_selling_price,
                  created_at: args.p_created_at, updated_at: new Date().toISOString(),
                },
                error: null,
              }
            : { data: {}, error: null },
    });

    await pushOutbox(fake.client, SHOP_ID, 0);
    suspended = false;
    const result = await pushOutbox(fake.client, SHOP_ID, BLOCKED_RETRY_MS);
    expect(result).toEqual({ pushed: 2, failed: 0, retryAt: null });
    expect(await db.outbox.count()).toBe(0);
  });

  it('reports a plan limit separately from suspension', async () => {
    await queueTwoChanges();
    const fake = createFakeSupabase({
      rpc: () => ({ data: null, error: { code: 'SP002', message: 'This shop’s plan allows 3 team members.' } }),
    });
    expect((await pushOutbox(fake.client, SHOP_ID, 0)).blocked).toBe('plan_limit');
  });
});

describe('reportSyncFailures', () => {
  beforeEach(async () => {
    await resetLocalDatabase();
  });

  async function failEverything(code: string | undefined): Promise<void> {
    const fake = createFakeSupabase({ rpc: () => ({ data: null, error: { code, message: 'Refused: secret detail 0821234567' } }) });
    await pushOutbox(fake.client, SHOP_ID, 0);
  }

  it('sends only operation types and error codes, grouped, once', async () => {
    await queueTwoChanges();
    await failEverything('23514');

    const fake = createFakeSupabase({ rpc: () => ({ data: 2, error: null }) });
    expect(await reportSyncFailures(fake.client, SHOP_ID)).toBe(2);
    expect(fake.rpc).toHaveBeenCalledTimes(1);
    const [name, args] = fake.rpc.mock.calls[0];
    expect(name).toBe('report_sync_failures');
    const reports = (args as { p_reports: Record<string, unknown>[] }).p_reports;
    expect(args).toMatchObject({ p_shop_id: SHOP_ID });
    for (const report of reports) {
      expect(Object.keys(report).sort()).toEqual(['count', 'error_code', 'op_type']);
      expect(report.error_code).toBe('23514');
      expect(report.op_type).toMatch(/^[a-z_]{1,40}$/);
    }
    expect(reports.reduce((sum, r) => sum + (r.count as number), 0)).toBe(2);
    expect(JSON.stringify(args)).not.toContain('0821234567');

    expect(await reportSyncFailures(fake.client, SHOP_ID)).toBe(0);
    expect(fake.rpc).toHaveBeenCalledTimes(1);
  });

  it('replaces codes the server would reject with unknown', async () => {
    await queueTwoChanges();
    await failEverything('42501');
    await db.outbox.toCollection().modify({ lastErrorCode: 'not a code!' });

    const fake = createFakeSupabase({ rpc: () => ({ data: 1, error: null }) });
    await reportSyncFailures(fake.client, SHOP_ID);
    const reports = (fake.rpc.mock.calls[0][1] as { p_reports: { error_code: string }[] }).p_reports;
    expect(reports.every((r) => r.error_code === 'unknown')).toBe(true);
  });

  it('tries again next time when the report itself fails', async () => {
    await queueTwoChanges();
    await failEverything('23514');

    const offline = createFakeSupabase({
      rpc: () => {
        throw new TypeError('Failed to fetch');
      },
    });
    expect(await reportSyncFailures(offline.client, SHOP_ID)).toBe(0);
    const refused = createFakeSupabase({ rpc: () => ({ data: null, error: { code: '42501', message: 'no' } }) });
    expect(await reportSyncFailures(refused.client, SHOP_ID)).toBe(0);

    const online = createFakeSupabase({ rpc: () => ({ data: 2, error: null }) });
    expect(await reportSyncFailures(online.client, SHOP_ID)).toBe(2);
  });

  it('does nothing when there are no failures', async () => {
    await queueTwoChanges();
    const fake = createFakeSupabase({ rpc: () => ({ data: 0, error: null }) });
    expect(await reportSyncFailures(fake.client, SHOP_ID)).toBe(0);
    expect(fake.rpc).not.toHaveBeenCalled();
  });
});
