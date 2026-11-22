/** Helpers shared by the ported shop functions. */
import { invalid } from '../db/errors';
import { toApiRow, toCents, type ApiRow } from '../db/rows';
import { one, type SqlRow, type SqlValue, type SyncSql } from '../db/sql';

export const uuid = () => crypto.randomUUID();

/** private.clean_barcode: drop all whitespace. */
export const cleanBarcode = (value: unknown) => String(value ?? '').replace(/\s/g, '');

/** btrim(coalesce(x, '')) */
export const trimmed = (value: unknown) => (value === null || value === undefined ? '' : String(value).trim());

/** nullif(btrim(coalesce(x, '')), '') */
export const optionalTrimmed = (value: unknown) => trimmed(value) || null;

/** private.optional_text: null keeps the current value; blank clears it; too long is refused. */
export function optionalText(value: unknown, current: string | null, max: number, label: string): string | null {
  if (value === null || value === undefined) return current;
  const clean = trimmed(value) || null;
  if (clean !== null && [...clean].length > max) throw invalid(`${label} is too long (up to ${max} characters).`);
  return clean;
}

export const charLength = (s: string) => [...s].length;

/** An optional price from the app as cents, or null. */
export function optionalCents(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  try {
    return toCents(value);
  } catch {
    throw invalid('Prices must be numbers.');
  }
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** A required id argument; Postgres would refuse a malformed uuid with 22P02. */
export function idArg(value: unknown, message: string): string {
  if (value === null || value === undefined) throw invalid(message);
  if (!isUuid(value)) throw invalid(message);
  return value.toLowerCase();
}

export function optionalId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (!isUuid(value)) throw invalid('Invalid id.');
  return value.toLowerCase();
}

export function intArg(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isInteger(n)) throw invalid('Expected a whole number.');
  return n;
}

export function dateArg(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) throw invalid('Invalid date.');
  return s;
}

export function timestampArg(value: unknown, fallback: string): string {
  if (value === null || value === undefined) return fallback;
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) throw invalid('Invalid timestamp.');
  return d.toISOString();
}

export function insert(sql: SyncSql, table: string, row: Record<string, SqlValue>): void {
  const cols = Object.keys(row);
  sql.run(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    ...cols.map((c) => row[c])
  );
}

export function get(sql: SyncSql, table: string, id: string): SqlRow | null {
  return one(sql, `SELECT * FROM ${table} WHERE id = ?`, id);
}

export function api(table: string, row: SqlRow | null): ApiRow | null {
  return toApiRow(table, row);
}

/** private.product_stock */
export function productStock(sql: SyncSql, shopId: string, productId: string): number {
  return Number(
    one<{ n: number }>(sql, 'SELECT coalesce(sum(quantity), 0) AS n FROM stock_batches WHERE shop_id = ? AND product_id = ?', shopId, productId)?.n ?? 0
  );
}

/** private.sellable_stock: units in batches not yet expired on the shop's today. */
export function sellableStock(sql: SyncSql, shopId: string, productId: string, today: string): number {
  return Number(
    one<{ n: number }>(
      sql,
      `SELECT coalesce(sum(quantity), 0) AS n FROM stock_batches
        WHERE shop_id = ? AND product_id = ? AND quantity > 0 AND (expiry_date IS NULL OR expiry_date >= ?)`,
      shopId,
      productId,
      today
    )?.n ?? 0
  );
}
