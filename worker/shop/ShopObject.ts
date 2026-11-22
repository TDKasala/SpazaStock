/**
 * One Durable Object per shop, holding that shop's ledger in its own SQLite database
 * (schema: worker/shop/schema.sql). Calls reach it only through the Worker, which has already
 * checked the session and the caller's membership and passes them in as ShopCtx.
 *
 * Calls run one at a time and never await while touching storage, so each RPC is atomic and
 * isolated: this replaces Postgres row locks and transactions.
 */
import { DurableObject } from 'cloudflare:workers';
import SHOP_SCHEMA from './schema.sql';
import { durableObjectSql } from '../db/doSql';
import { DbError, errorBody, type ApiErrorBody } from '../db/errors';
import { toApiRows, type ApiRow } from '../db/rows';
import type { SqlValue, SyncSql } from '../db/sql';
import { TABLES } from '../db/columns';
import { SHOP_FUNCTIONS } from './functions';
import { generateExpiryAlerts, generateLowStockAlerts } from './alerts';
import { insert } from './common';
import type { ShopCtx, ShopEffect, ShopInputs } from './context';

/** Schema versions applied in order; version 1 is the generated schema. */
const MIGRATIONS: string[] = [SHOP_SCHEMA];

export type ShopRpcResult = { data: unknown; effects: ShopEffect[] } | { error: ApiErrorBody };

/** Splits a schema file into statements. Triggers in the generated file are one line each. */
export function statements(schema: string): string[] {
  return schema
    .split('\n')
    .filter((line) => !line.startsWith('--'))
    .join('\n')
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface ShopBundle {
  format: 'spazastock-shop/1';
  shopId: string;
  tables: { table: string; rows: Record<string, SqlValue>[] }[];
}

const PULL_TABLES = new Set([
  'products',
  'product_packagings',
  'product_barcodes',
  'stock_batches',
  'sale_items',
  'stock_discrepancies',
  'expiry_alerts',
  'low_stock_dismissals',
  'wholesalers',
  'wholesale_orders',
  'wholesale_order_items',
  'wholesale_order_receipts',
  'wholesale_order_receipt_lines',
  'sales',
  'stock_movements',
]);

/** Readable by id or column match; the last two have no updated_at, so they are not pulled. */
const SELECT_TABLES = new Set([...PULL_TABLES, 'sale_item_voids', 'expiry_resolutions']);

export class ShopObject extends DurableObject {
  private sql: SyncSql;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.sql = durableObjectSql(ctx.storage);
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  private migrate(): void {
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS _schema (version INTEGER NOT NULL)');
    const current = Number(this.sql.all<{ v: number }>('SELECT max(version) AS v FROM _schema')[0]?.v ?? 0);
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.ctx.storage.transactionSync(() => {
        for (const statement of statements(MIGRATIONS[v])) this.ctx.storage.sql.exec(statement);
        this.ctx.storage.sql.exec('INSERT INTO _schema (version) VALUES (?)', v + 1);
      });
    }
  }

  /** Runs one ported shop function atomically. */
  async rpc(name: string, ctx: ShopCtx, inputs: ShopInputs, args: Record<string, unknown>): Promise<ShopRpcResult> {
    const fn = SHOP_FUNCTIONS[name];
    if (!fn) return { error: { code: '42883', message: `function ${name} does not exist` } };
    const effects: ShopEffect[] = [];
    try {
      const data = this.sql.transaction(() => fn({ ctx, effects, inputs }, this.sql, args));
      return { data, effects };
    } catch (err) {
      if (!(err instanceof DbError)) console.error(`shop rpc ${name} failed`, err);
      return { error: errorBody(err) };
    }
  }

  /** Scheduled job: expiry and low-stock alerts for this shop. */
  async runAlerts(ctx: ShopCtx, inputs: ShopInputs): Promise<{ effects: ShopEffect[]; expiry: number; lowStock: number }> {
    const effects: ShopEffect[] = [];
    const call = { ctx, effects, inputs };
    const result = this.sql.transaction(() => ({
      expiry: generateExpiryAlerts(call, this.sql).inserted,
      lowStock: generateLowStockAlerts(call, this.sql).inserted,
    }));
    return { effects, ...result };
  }

  /**
   * The app's delta pull: rows with updated_at after `since`, ordered by updated_at then id, one
   * page at an offset (PostgREST .gt().order().range()). sale_items carry their sale's sold_at
   * and idempotency_key, like the PostgREST embed did.
   */
  async pull(table: string, since: string, offset: number, limit: number): Promise<ApiRow[]> {
    if (!PULL_TABLES.has(table)) throw new DbError('42501', `Table ${table} cannot be pulled.`);
    const size = Math.max(1, Math.min(limit, 1000));
    const rows = this.sql.all(
      `SELECT * FROM ${table} WHERE updated_at > ? ORDER BY updated_at, id LIMIT ? OFFSET ?`,
      new Date(since).toISOString(),
      size,
      Math.max(0, offset)
    );
    const out = toApiRows(table, rows);
    if (table === 'sale_items' && out.length) {
      const ids = [...new Set(out.map((r) => String(r.sale_id)))];
      const sales = new Map(
        this.sql
          .all<{ id: string; sold_at: string; idempotency_key: string }>(
            `SELECT id, sold_at, idempotency_key FROM sales WHERE id IN (${ids.map(() => '?').join(', ')})`,
            ...ids
          )
          .map((s) => [s.id, { sold_at: s.sold_at, idempotency_key: s.idempotency_key }])
      );
      for (const r of out) r.sales = sales.get(String(r.sale_id)) ?? null;
    }
    return out;
  }

  /** Owners and managers marking a stock discrepancy resolved (the app's direct table update). */
  async resolveDiscrepancy(id: string, resolvedAt: string | null): Promise<ApiRow[]> {
    const changed = this.sql.run('UPDATE stock_discrepancies SET resolved_at = ? WHERE id = ?', resolvedAt, id);
    return changed ? toApiRows('stock_discrepancies', this.sql.all('SELECT * FROM stock_discrepancies WHERE id = ?', id)) : [];
  }

  /** Reads rows for the app's other direct table reads (by id or by an exact column match). */
  async select(table: string, filters: Record<string, SqlValue>, limit = 1000): Promise<ApiRow[]> {
    if (!SELECT_TABLES.has(table)) throw new DbError('42501', `Table ${table} cannot be read.`);
    const meta = TABLES[table];
    const where: string[] = [];
    const values: SqlValue[] = [];
    for (const [column, value] of Object.entries(filters)) {
      const known = meta.columns.find(([api]) => api === column);
      if (!known) throw new DbError('42703', `column ${column} does not exist`);
      where.push(value === null ? `${known[1]} IS NULL` : `${known[1]} = ?`);
      if (value !== null) values.push(value);
    }
    const rows = this.sql.all(
      `SELECT * FROM ${table} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} LIMIT ?`,
      ...values,
      Math.min(limit, 1000)
    );
    return toApiRows(table, rows);
  }

  /**
   * One-time import of this shop's rows from Supabase (scripts/migrate-data). Refuses to run on a
   * shop that already has data unless `replace` is set, and writes everything or nothing.
   */
  async importBundle(bundle: ShopBundle, replace = false): Promise<Record<string, number>> {
    const hasData = this.sql.all('SELECT 1 AS x FROM products LIMIT 1').length > 0;
    if (hasData && !replace) throw new DbError('23505', 'This shop already has data.');
    const counts: Record<string, number> = {};
    this.sql.transaction(() => {
      if (replace) {
        for (const { table } of [...bundle.tables].reverse()) this.sql.run(`DELETE FROM ${table}`);
      }
      for (const { table, rows } of bundle.tables) {
        if (!TABLES[table] || TABLES[table].store !== 'shop') throw new DbError('22023', `Unknown shop table ${table}.`);
        for (const row of rows) {
          if (row.shop_id !== undefined && row.shop_id !== bundle.shopId) {
            throw new DbError('22023', `A ${table} row belongs to another shop.`);
          }
          insert(this.sql, table, row);
        }
        counts[table] = rows.length;
      }
      const broken = this.sql.all('PRAGMA foreign_key_check');
      if (broken.length) throw new DbError('23503', `${broken.length} rows point at missing rows.`);
    });
    return counts;
  }

  /** Totals checked after an import against the export manifest (prepare-load verify step). */
  async stats(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const [table, meta] of Object.entries(TABLES)) {
      if (meta.store !== 'shop') continue;
      out[`rows:${table}`] = Number(this.sql.all<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)[0].n);
    }
    const one = (q: string) => Number(this.sql.all<{ n: number }>(q)[0]?.n ?? 0);
    out.units_in_stock = one('SELECT coalesce(sum(quantity), 0) AS n FROM stock_batches');
    out.movement_units = one('SELECT coalesce(sum(quantity_delta), 0) AS n FROM stock_movements');
    out.sales_total_cents = one('SELECT coalesce(sum(total_amount_cents), 0) AS n FROM sales');
    out.voided_units = one('SELECT coalesce(sum(voided_quantity), 0) AS n FROM sale_items');
    return out;
  }
}
