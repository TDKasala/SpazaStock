/**
 * Shapes stored rows the way the app received them from Postgres (to_jsonb): money as a decimal
 * number under its original name, booleans as true/false, JSON columns parsed, timestamps as ISO.
 */
import { TABLES } from './columns';
import type { SqlRow, SqlValue } from './sql';

export type ColumnKind = 'text' | 'int' | 'real' | 'bool' | 'json' | 'money' | 'ts' | 'date';

export interface TableMeta {
  store: 'd1' | 'shop';
  primaryKey: string[];
  /** [api name, sqlite name, kind] */
  columns: [string, string, ColumnKind][];
}

export type ApiRow = Record<string, unknown>;

export function tableMeta(table: string): TableMeta {
  const meta = TABLES[table];
  if (!meta) throw new Error(`Unknown table ${table}`);
  return meta;
}

export function centsToDecimal(cents: number): number {
  return Math.round(cents) / 100;
}

/**
 * A price from the app (number or numeric string) to whole cents, like numeric(12,2) rounding:
 * half away from zero. Throws on something that is not a finite number.
 */
export function toCents(value: unknown): number {
  const n = typeof value === 'string' ? Number(value.trim()) : (value as number);
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new TypeError('not a number');
  // Work on the decimal text so 0.285 rounds like Postgres (to 0.29), not like binary floating point.
  const [int, frac = ''] = Math.abs(n).toFixed(10).split('.');
  let cents = Number(int) * 100 + Number(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) cents += 1;
  return n < 0 ? -cents : cents;
}

export function toApiRow(table: string, row: SqlRow | null | undefined): ApiRow | null {
  if (!row) return null;
  const out: ApiRow = {};
  for (const [api, column, kind] of tableMeta(table).columns) {
    if (!(column in row)) continue;
    const v = row[column];
    if (v === null || v === undefined) {
      out[api] = null;
      continue;
    }
    switch (kind) {
      case 'money':
        out[api] = centsToDecimal(Number(v));
        break;
      case 'bool':
        out[api] = v === 1 || v === '1';
        break;
      case 'json':
        out[api] = typeof v === 'string' ? JSON.parse(v) : v;
        break;
      default:
        out[api] = v;
    }
  }
  return out;
}

export function toApiRows(table: string, rows: SqlRow[]): ApiRow[] {
  return rows.map((r) => toApiRow(table, r)!);
}

/** One value from the app to its stored form (inverse of toApiRow for a single column). */
export function toStored(kind: ColumnKind, value: unknown): SqlValue {
  if (value === null || value === undefined) return null;
  switch (kind) {
    case 'money':
      return toCents(value);
    case 'bool':
      return value ? 1 : 0;
    case 'json':
      return JSON.stringify(value);
    case 'ts':
      return toIsoTimestamp(value);
    case 'int':
    case 'real':
      return Number(value);
    default:
      return String(value);
  }
}

/** Any timestamp the app sends (ISO with offset or Z) → UTC with milliseconds. */
export function toIsoTimestamp(value: unknown): string {
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) throw new TypeError(`not a timestamp: ${String(value)}`);
  return d.toISOString();
}

export function nowIso(): string {
  return new Date().toISOString();
}
