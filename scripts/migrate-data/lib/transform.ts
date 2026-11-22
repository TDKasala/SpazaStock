/**
 * Turns an export (exportDatabase.ts) into what Cloudflare loads (docs/data-migration.md, step 2):
 *   - SQL statements for the shared D1 database
 *   - one row bundle per shop for its Durable Object
 * and proves, before anything is loaded, that the converted data reproduces every total in the
 * export manifest.
 *
 * Numbers are read from the exact JSON source text, so a price such as 0.29 becomes 29 cents
 * without passing through floating point.
 */
import type { ExportManifest } from './exportDatabase.ts';
import { isMoney, sqliteColumnName, sqliteTableName, storeOf } from './partition.ts';

/** A JSON number kept as its source text. */
export class ExactNumber {
  readonly source: string;
  constructor(source: string) {
    this.source = source;
  }
}

type Json = null | boolean | string | ExactNumber | Json[] | { [k: string]: Json };
export type SqlValue = null | string | number;
export type Row = Record<string, SqlValue>;

export function parseExact(line: string): Record<string, Json> {
  // Node's JSON.parse passes the number's source text to the reviver (context.source).
  const reviver = (_key: string, value: unknown, context?: { source?: string }) =>
    typeof value === 'number' ? new ExactNumber(context?.source ?? String(value)) : value;
  return JSON.parse(line, reviver as (this: unknown, key: string, value: unknown) => unknown) as Record<string, Json>;
}

/** Back to plain JSON values, for jsonb and array columns. */
function plain(value: Json): unknown {
  if (value instanceof ExactNumber) return Number(value.source);
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  }
  return value;
}

/** "18.5" → 1850, "-0.29" → -29. Throws on more than two decimals or anything that is not a decimal. */
export function decimalToCents(source: string): number {
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(source);
  const fraction = m?.[3] ?? '';
  // "18.500" is fine (numeric without a scale can print extra zeros); "18.505" is not money.
  if (!m || /[^0]/.test(fraction.slice(2))) throw new Error(`Not a money value with at most two decimals: ${source}`);
  const cents = Number(m[2]) * 100 + Number(fraction.slice(0, 2).padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) throw new Error(`Money value out of range: ${source}`);
  return m[1] && cents !== 0 ? -cents : cents;
}

/**
 * Postgres timestamptz text ("2026-11-03T07:48:20.256789+00:00", any offset) → UTC with
 * milliseconds ("2026-11-03T07:48:20.256Z"). Sub-millisecond digits are dropped, not rounded,
 * so the result is never later than the original.
 */
export function toIsoMillis(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}(?::?\d{2})?)$/.exec(value);
  if (!m) throw new Error(`Not a timestamp: ${value}`);
  const ms = Number((m[7] ?? '').slice(0, 3).padEnd(3, '0'));
  let offsetMinutes = 0;
  if (m[8] !== 'Z') {
    const sign = m[8][0] === '-' ? -1 : 1;
    const digits = m[8].slice(1).replace(':', '');
    offsetMinutes = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4) || '0'));
  }
  const utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], ms) - offsetMinutes * 60_000;
  return new Date(utc).toISOString();
}

export function convertValue(table: string, column: string, pgType: string, value: Json | undefined): SqlValue {
  if (value === null || value === undefined) return null;
  if (pgType === 'jsonb' || pgType === 'json' || pgType.endsWith('[]')) return JSON.stringify(plain(value));
  if (pgType === 'timestamp with time zone') return toIsoMillis(String(value));
  if (pgType === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`${table}.${column}: expected boolean`);
    return value ? 1 : 0;
  }
  if (value instanceof ExactNumber) {
    if (pgType.startsWith('numeric') && isMoney(table, column)) return decimalToCents(value.source);
    const n = Number(value.source);
    if (['integer', 'smallint', 'bigint'].includes(pgType) && !Number.isSafeInteger(n)) {
      throw new Error(`${table}.${column}: ${value.source} is not a safe integer`);
    }
    return n;
  }
  if (typeof value === 'string') return value; // uuid, text, date
  throw new Error(`${table}.${column} (${pgType}): unexpected value ${JSON.stringify(plain(value))}`);
}

/** Reads one exported file as lines. The CLI reads from disk, tests from memory. */
export type ReadLines = (file: string) => AsyncIterable<string> | Iterable<string>;

export interface ShopBundle {
  format: 'spazastock-shop/1';
  shopId: string;
  /** In load order: parents first. */
  tables: { table: string; rows: Row[] }[];
}

export interface LoadPlan {
  /** Statements for D1, users first, parents before children. */
  d1Statements: string[];
  d1Rows: Record<string, number>;
  shops: ShopBundle[];
  verification: VerificationResult;
}

export interface VerificationResult {
  ok: boolean;
  mismatches: string[];
  /** What was compared, for the report. */
  compared: number;
}

function sqlLiteral(value: SqlValue): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number') return String(value);
  return `'${value.replace(/'/g, "''")}'`;
}

export function insertStatement(table: string, row: Row): string {
  const cols = Object.keys(row);
  return `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => sqlLiteral(row[c])).join(', ')});`;
}

function convertRow(table: string, types: Record<string, string>, raw: Record<string, Json>): Row {
  const out: Row = {};
  for (const [column, pgType] of Object.entries(types)) {
    out[sqliteColumnName(table, column)] = convertValue(table, column, pgType, raw[column]);
  }
  const unknown = Object.keys(raw).filter((c) => !(c in types));
  if (unknown.length) throw new Error(`${table}: exported columns missing from the schema: ${unknown.join(', ')}`);
  return out;
}

function convertUser(raw: Record<string, Json>): Row {
  const hash = raw.encrypted_password ? String(raw.encrypted_password) : null;
  if (hash && !/^\$2[aby]\$\d{2}\$/.test(hash)) throw new Error(`User ${raw.id}: password hash is not bcrypt`);
  const created = raw.created_at ? toIsoMillis(String(raw.created_at)) : null;
  const email = String(raw.email ?? '').trim().toLowerCase();
  if (!email) throw new Error(`User ${raw.id} has no email; the new sign-in is email-only`);
  return {
    id: String(raw.id),
    email,
    password_hash: hash,
    password_kind: hash ? 'bcrypt' : null,
    email_confirmed_at: raw.email_confirmed_at ? toIsoMillis(String(raw.email_confirmed_at)) : null,
    created_at: created ?? new Date(0).toISOString(),
    updated_at: raw.updated_at ? toIsoMillis(String(raw.updated_at)) : (created ?? new Date(0).toISOString()),
    last_sign_in_at: raw.last_sign_in_at ? toIsoMillis(String(raw.last_sign_in_at)) : null,
    metadata: JSON.stringify(plain(raw.raw_user_meta_data ?? {}) ?? {}),
  };
}

const sum = (rows: Row[] | undefined, column: string) =>
  (rows ?? []).reduce((n, r) => n + (typeof r[column] === 'number' ? (r[column] as number) : 0), 0);

/** Compares the converted rows with the totals Postgres computed at export time. */
export function verifyAgainstManifest(
  manifest: Pick<ExportManifest, 'checks' | 'tables' | 'users'>,
  d1: Record<string, Row[]>,
  users: Row[],
  shops: ShopBundle[]
): VerificationResult {
  const mismatches: string[] = [];
  let compared = 0;
  const expect = (label: string, actual: unknown, expected: unknown) => {
    compared++;
    if (String(actual) !== String(expected)) mismatches.push(`${label}: got ${actual}, expected ${expected}`);
  };

  // Every table's row count.
  const shopCounts = new Map<string, number>();
  for (const bundle of shops) for (const t of bundle.tables) shopCounts.set(t.table, (shopCounts.get(t.table) ?? 0) + t.rows.length);
  for (const t of manifest.tables) {
    const name = sqliteTableName(t.name);
    const actual = storeOf(t.name) === 'd1' ? (d1[name]?.length ?? 0) : (shopCounts.get(name) ?? 0);
    expect(`rows ${t.name}`, actual, t.rows);
  }
  expect('rows auth.users', users.length, manifest.users.rows);

  const checkUsers = manifest.checks.users as { total: number; confirmed: number; with_password: number };
  expect('users confirmed', users.filter((u) => u.email_confirmed_at).length, checkUsers.confirmed);
  expect('users with password', users.filter((u) => u.password_hash).length, checkUsers.with_password);

  // Per shop totals: members from D1, the ledger from the shop bundle.
  const perShop = manifest.checks.shops as Record<string, Record<string, unknown>>;
  const bundles = new Map(shops.map((b) => [b.shopId, new Map(b.tables.map((t) => [t.table, t.rows]))]));
  for (const [shopId, c] of Object.entries(perShop)) {
    const t = bundles.get(shopId) ?? new Map<string, Row[]>();
    const label = (what: string) => `shop ${shopId} ${what}`;
    expect(label('members'), (d1.shop_members ?? []).filter((m) => m.shop_id === shopId).length, c.members);
    expect(label('products'), t.get('products')?.length ?? 0, c.products);
    expect(label('archived products'), (t.get('products') ?? []).filter((p) => p.archived_at).length, c.archived_products);
    expect(label('batches'), t.get('stock_batches')?.length ?? 0, c.batches);
    expect(label('units in stock'), sum(t.get('stock_batches'), 'quantity'), c.units_in_stock);
    expect(label('movements'), t.get('stock_movements')?.length ?? 0, c.movements);
    expect(label('movement units'), sum(t.get('stock_movements'), 'quantity_delta'), c.movement_units);
    expect(label('sales'), t.get('sales')?.length ?? 0, c.sales);
    expect(label('sales total (cents)'), sum(t.get('sales'), 'total_amount_cents'), decimalToCents(String(c.sales_total)));
    expect(label('sale items'), t.get('sale_items')?.length ?? 0, c.sale_items);
    expect(label('voided units'), sum(t.get('sale_items'), 'voided_quantity'), c.voided_units);
  }
  expect('shops', (d1.shops ?? []).length, Object.keys(perShop).length);

  const catalog = manifest.checks.catalog as { products: number; barcodes: number };
  expect('catalog products', d1.catalog_products?.length ?? 0, catalog.products);
  expect('catalog barcodes', d1.catalog_barcodes?.length ?? 0, catalog.barcodes);

  return { ok: mismatches.length === 0, mismatches, compared };
}

export async function buildLoadPlan(manifest: ExportManifest, readLines: ReadLines): Promise<LoadPlan> {
  // Column types recorded at export time describe exactly the data being converted.
  const columnTypes = Object.fromEntries(
    manifest.tables.map((t) => [t.name, Object.fromEntries(t.columns.map((c) => [c.name, c.type]))])
  );
  const users: Row[] = [];
  for await (const line of readLines(manifest.users.file)) users.push(convertUser(parseExact(line)));

  const d1: Record<string, Row[]> = {};
  const shopTables = new Map<string, Map<string, Row[]>>();
  const shopIds = new Set<string>();

  for (const t of manifest.tables) {
    const types = columnTypes[t.name];
    const name = sqliteTableName(t.name);
    const store = storeOf(t.name);
    if (t.rows === 0) continue;
    for await (const line of readLines(t.file)) {
      const row = convertRow(t.name, types, parseExact(line));
      if (store === 'd1') {
        (d1[name] ??= []).push(row);
        if (name === 'shops') shopIds.add(String(row.id));
        continue;
      }
      const shopId = row.shop_id;
      if (typeof shopId !== 'string') throw new Error(`${t.name}: row without shop_id`);
      let tables = shopTables.get(shopId);
      if (!tables) shopTables.set(shopId, (tables = new Map()));
      (tables.get(name) ?? tables.set(name, []).get(name)!).push(row);
    }
  }

  for (const shopId of shopTables.keys()) {
    if (!shopIds.has(shopId)) throw new Error(`Shop ledger rows reference unknown shop ${shopId}`);
  }

  // Manifest tables are already in load order; keep that order inside each bundle.
  const shopOrder = manifest.tables.filter((t) => storeOf(t.name) === 'shop').map((t) => sqliteTableName(t.name));
  const shops: ShopBundle[] = [...shopIds].sort().map((shopId) => ({
    format: 'spazastock-shop/1',
    shopId,
    tables: shopOrder.map((table) => ({ table, rows: shopTables.get(shopId)?.get(table) ?? [] })),
  }));

  const d1Statements: string[] = ['PRAGMA defer_foreign_keys = true;'];
  // The production copy replaces whatever is there (reference data seeded by 0003, test rows).
  const d1Order = manifest.tables.filter((t) => storeOf(t.name) === 'd1').map((t) => sqliteTableName(t.name));
  for (const table of [...d1Order].reverse()) d1Statements.push(`DELETE FROM ${table};`);
  d1Statements.push('DELETE FROM sessions;', 'DELETE FROM auth_codes;', 'DELETE FROM users;');
  const d1Rows: Record<string, number> = { users: users.length };
  for (const u of users) d1Statements.push(insertStatement('users', u));
  for (const t of manifest.tables) {
    if (storeOf(t.name) !== 'd1') continue;
    const name = sqliteTableName(t.name);
    d1Rows[name] = d1[name]?.length ?? 0;
    for (const row of d1[name] ?? []) d1Statements.push(insertStatement(name, row));
  }

  return { d1Statements, d1Rows, shops, verification: verifyAgainstManifest(manifest, d1, users, shops) };
}
