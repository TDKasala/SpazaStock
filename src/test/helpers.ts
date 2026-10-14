import { vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

export const SHOP_ID = '11111111-1111-4111-8111-111111111111';
export const OTHER_SHOP_ID = '22222222-2222-4222-8222-222222222222';

export function setOnline(online: boolean): void {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => online });
  Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, get: () => online });
}

type RpcResult = { data: unknown; error: { code?: string; message: string } | null };
type RpcHandler = (name: string, args: Record<string, unknown>) => RpcResult | Promise<RpcResult>;
type Rows = Record<string, Array<Record<string, unknown>>>;

/**
 * Minimal stand-in for the parts of supabase-js the sync engine uses:
 * `rpc`, `from().select().eq().gt().order().order().range()`, `from().select().eq().eq().maybeSingle()`
 * and `from().update().eq()`.
 */
export function createFakeSupabase(options: { rpc?: RpcHandler; rows?: Rows } = {}) {
  const rows: Rows = options.rows ?? {};
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) =>
    options.rpc ? options.rpc(name, args) : { data: null, error: null }
  );
  const updates: Array<{ table: string; values: Record<string, unknown>; id: unknown }> = [];

  const from = vi.fn((table: string) => {
    const filters: { shopId?: unknown; id?: unknown; since?: string } = {};
    const select = {
      eq(column: string, value: unknown) {
        if (column === 'shop_id') filters.shopId = value;
        if (column === 'id') filters.id = value;
        return select;
      },
      async maybeSingle() {
        const row = (rows[table] ?? []).find(
          (r) => (filters.shopId === undefined || r.shop_id === filters.shopId) && r.id === filters.id
        );
        return { data: row ?? null, error: null };
      },
      gt(_column: string, value: string) {
        filters.since = value;
        return select;
      },
      order() {
        return select;
      },
      async range(fromIndex: number, toIndex: number) {
        const matching = (rows[table] ?? [])
          .filter((row) => filters.shopId === undefined || row.shop_id === filters.shopId)
          .filter((row) => !filters.since || String(row.updated_at) > filters.since)
          .sort((a, b) => String(a.updated_at).localeCompare(String(b.updated_at)));
        return { data: matching.slice(fromIndex, toIndex + 1), error: null };
      },
    };
    return {
      select: () => select,
      update: (values: Record<string, unknown>) => ({
        async eq(_column: string, id: unknown) {
          updates.push({ table, values, id });
          return { data: null, error: null };
        },
      }),
    };
  });

  const client = { rpc, from } as unknown as SupabaseClient;
  return { client, rpc, from, rows, updates };
}
