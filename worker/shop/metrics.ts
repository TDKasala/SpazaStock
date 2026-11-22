/**
 * Per-shop figures for the platform admin console. Postgres computed these across all shops in
 * one query; here each shop's object answers for itself and the Worker adds the answers up.
 */
import type { SyncSql } from '../db/sql';
import { localDate } from './context';

const n = (sql: SyncSql, q: string, ...p: (string | number | null)[]) => Number(sql.all<{ n: number }>(q, ...p)[0]?.n ?? 0);

/** admin_get_tenant's inventory and activity blocks, and tenant_search's counts. */
export function tenantStats(sql: SyncSql, now: string) {
  const since30 = new Date(Date.parse(now) - 30 * 86_400_000).toISOString();
  return {
    products: n(sql, 'SELECT count(*) AS n FROM products'),
    active_products: n(sql, 'SELECT count(*) AS n FROM products WHERE archived_at IS NULL'),
    archived_products: n(sql, 'SELECT count(*) AS n FROM products WHERE archived_at IS NOT NULL'),
    batches_in_stock: n(sql, 'SELECT count(*) AS n FROM stock_batches WHERE quantity > 0'),
    units_in_stock: n(sql, 'SELECT coalesce(sum(quantity), 0) AS n FROM stock_batches WHERE quantity > 0'),
    stock_value_at_cost_cents: n(sql, 'SELECT coalesce(sum(quantity * cost_price_per_unit_cents), 0) AS n FROM stock_batches WHERE quantity > 0'),
    batches_without_cost: n(sql, 'SELECT count(*) AS n FROM stock_batches WHERE quantity > 0 AND cost_price_per_unit_cents IS NULL'),
    last_movement_at: (sql.all<{ t: string | null }>('SELECT max(created_at) AS t FROM stock_movements')[0]?.t ?? null) as string | null,
    movements_30d: n(sql, 'SELECT count(*) AS n FROM stock_movements WHERE created_at > ?', since30),
    sales_30d: n(sql, 'SELECT count(*) AS n FROM sales WHERE created_at > ?', since30),
    open_expiry_alerts: n(sql, 'SELECT count(*) AS n FROM expiry_alerts WHERE resolved_at IS NULL'),
  };
}

export type TenantStats = ReturnType<typeof tenantStats>;

const countBy = (sql: SyncSql, q: string, ...p: string[]) =>
  Object.fromEntries(sql.all<{ k: string; n: number }>(q, ...p).map((r) => [r.k, Number(r.n)]));

/** admin_platform_overview's stock, sales and expiry blocks for one shop, over [from, to). */
export function rangeMetrics(sql: SyncSql, from: string, to: string) {
  return {
    movements: n(sql, 'SELECT count(*) AS n FROM stock_movements WHERE created_at >= ? AND created_at < ?', from, to),
    units_in: n(sql, 'SELECT coalesce(sum(quantity_delta), 0) AS n FROM stock_movements WHERE quantity_delta > 0 AND created_at >= ? AND created_at < ?', from, to),
    units_out: n(sql, 'SELECT coalesce(-sum(quantity_delta), 0) AS n FROM stock_movements WHERE quantity_delta < 0 AND created_at >= ? AND created_at < ?', from, to),
    stock_by_reason: countBy(sql, 'SELECT reason AS k, count(*) AS n FROM stock_movements WHERE created_at >= ? AND created_at < ? GROUP BY reason', from, to),
    sales: n(sql, 'SELECT count(*) AS n FROM sales WHERE created_at >= ? AND created_at < ?', from, to),
    sales_total_cents: n(sql, 'SELECT coalesce(sum(total_amount_cents), 0) AS n FROM sales WHERE created_at >= ? AND created_at < ?', from, to),
    sale_items: n(sql, 'SELECT count(*) AS n FROM sale_items WHERE created_at >= ? AND created_at < ?', from, to),
    voided_units: n(sql, 'SELECT coalesce(sum(quantity), 0) AS n FROM sale_item_voids WHERE created_at >= ? AND created_at < ?', from, to),
    discrepancies: n(sql, 'SELECT count(*) AS n FROM stock_discrepancies WHERE created_at >= ? AND created_at < ?', from, to),
    expiry_created: n(sql, 'SELECT count(*) AS n FROM expiry_alerts WHERE created_at >= ? AND created_at < ?', from, to),
    expiry_by_kind: countBy(sql, 'SELECT kind AS k, count(*) AS n FROM expiry_alerts WHERE created_at >= ? AND created_at < ? GROUP BY kind', from, to),
    expiry_resolved: n(sql, 'SELECT count(*) AS n FROM expiry_alerts WHERE resolved_at >= ? AND resolved_at < ?', from, to),
    expiry_by_resolution: countBy(sql, 'SELECT resolution AS k, count(*) AS n FROM expiry_alerts WHERE resolved_at >= ? AND resolved_at < ? GROUP BY resolution', from, to),
    expiry_open: n(sql, 'SELECT count(*) AS n FROM expiry_alerts WHERE resolved_at IS NULL'),
    expiry_discarded_units: n(sql, `SELECT coalesce(sum(quantity), 0) AS n FROM expiry_resolutions WHERE action = 'discarded' AND created_at >= ? AND created_at < ?`, from, to),
    products_created: n(sql, 'SELECT count(*) AS n FROM products WHERE created_at >= ? AND created_at < ?', from, to),
    units_by_reason: countBy(sql, 'SELECT reason AS k, sum(abs(quantity_delta)) AS n FROM stock_movements WHERE created_at >= ? AND created_at < ? GROUP BY reason', from, to),
    actors: sql
      .all<{ a: string }>('SELECT DISTINCT actor_id AS a FROM stock_movements WHERE actor_id IS NOT NULL AND created_at >= ? AND created_at < ?', from, to)
      .map((r) => r.a),
    tracks_expiry: n(sql, 'SELECT count(*) AS n FROM stock_batches WHERE expiry_date IS NOT NULL') > 0,
  };
}

export type RangeMetrics = ReturnType<typeof rangeMetrics>;

/** Start of the bucket (day, ISO week from Monday, month) containing a local date, as YYYY-MM-DD. */
export function bucketStart(date: string, bucket: 'day' | 'week' | 'month'): string {
  if (bucket === 'day') return date;
  if (bucket === 'month') return `${date.slice(0, 7)}-01`;
  const d = new Date(`${date}T00:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - back * 86_400_000).toISOString().slice(0, 10);
}

const SERIES_TABLES: Record<string, string> = {
  stock_movements: 'stock_movements',
  active_shops: 'stock_movements',
  sales: 'sales',
  expiry_alerts: 'expiry_alerts',
};

/** admin_growth_series for one shop's ledger metrics: events per bucket in the platform time zone. */
export function seriesCounts(sql: SyncSql, metric: string, from: string, to: string, timeZone: string, bucket: 'day' | 'week' | 'month'): Record<string, number> {
  const table = SERIES_TABLES[metric];
  if (!table) return {};
  const out: Record<string, number> = {};
  for (const { created_at } of sql.all<{ created_at: string }>(`SELECT created_at FROM ${table} WHERE created_at >= ? AND created_at < ?`, from, to)) {
    const key = bucketStart(localDate(created_at, timeZone), bucket);
    out[key] = (out[key] ?? 0) + 1;
  }
  // active_shops counts this shop once per bucket it was active in.
  if (metric === 'active_shops') for (const key of Object.keys(out)) out[key] = 1;
  return out;
}
