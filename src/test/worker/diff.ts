/**
 * Differential harness: runs each shop call against the original Postgres function (PGlite,
 * real migrations) and the ported TypeScript (SQLite, generated schema), then compares the
 * responses, the errors (code and message), and every shop table's contents.
 *
 * Normalised before comparing: ids generated inside a call (they are random on both sides),
 * created_at/updated_at, and timestamps taken from the server clock.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { PGlite } from '@electric-sql/pglite';
import { createDatabase, createShop, createUser, addMember, rpc, type User } from '../db/harness';
import { nodeSql, openShopDatabase } from './nodeSql';
import { SHOP_FUNCTIONS } from '../../../worker/shop/functions';
import type { ShopCall, ShopCtx, ShopEffect, ShopInputs, ShopRole } from '../../../worker/shop/context';
import { DbError } from '../../../worker/db/errors';
import { TABLES } from '../../../worker/db/columns';
import type { SyncSql } from '../../../worker/db/sql';
import { convertValue, parseExact } from '../../../scripts/migrate-data/lib/transform';

const ROOT = join(import.meta.dirname, '..', '..', '..');
export const SHOP_SCHEMA = readFileSync(join(ROOT, 'worker', 'shop', 'schema.sql'), 'utf8');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:?\d{2})?)$/;

export type Outcome = { data: unknown; error?: undefined } | { data?: undefined; error: { code: string; message: string } };

export interface Pair {
  pg: PGlite;
  db: DatabaseSync;
  sql: SyncSql;
  shopId: string;
  owner: User;
  manager: User;
  staff: User;
  known: Set<string>;
  /** Runs fn on both sides; returns both outcomes. */
  call(user: User | null, fn: string, args: Record<string, unknown>, inputs?: ShopInputs): Promise<{ pg: Outcome; sq: Outcome; effects: ShopEffect[] }>;
  /** Shop rows on both sides, normalised and sorted, per table. */
  tables(): Promise<{ pg: Record<string, unknown[]>; sq: Record<string, unknown[]> }>;
  ctxFor(user: User | null): Promise<ShopCtx>;
  close(): Promise<void>;
}

/** Ids a test chose (ids, users, shop) stay; anything else that looks like a uuid was generated. */
function normalise(value: unknown, known: Set<string>, now: number): unknown {
  if (Array.isArray(value)) return value.map((v) => normalise(v, known, now));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'created_at' || k === 'updated_at') continue;
      out[k] = normalise(v, known, now);
    }
    return out;
  }
  if (typeof value === 'string') {
    if (UUID.test(value)) return known.has(value.toLowerCase()) ? value.toLowerCase() : '<generated id>';
    if (ISO.test(value)) {
      const ms = Date.parse(value.replace(' ', 'T'));
      if (Math.abs(ms - now) < 120_000) return '<now>';
      return new Date(ms).toISOString();
    }
  }
  return value;
}

function collectIds(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) value.forEach((v) => collectIds(v, into));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => collectIds(v, into));
  else if (typeof value === 'string' && UUID.test(value)) into.add(value.toLowerCase());
}

/** jsonb sorts object keys; compare JSON columns as values, not text. */
function parseJsonColumns(table: string, row: Record<string, unknown>): Record<string, unknown> {
  const out = { ...row };
  for (const [, column, kind] of TABLES[table].columns) {
    if (kind === 'json' && typeof out[column] === 'string') out[column] = JSON.parse(out[column] as string);
  }
  return out;
}

const sortRows = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).sort().map((r) => JSON.parse(r));

export async function createPair(): Promise<Pair> {
  const pg = await createDatabase();
  const owner = await createUser(pg, 'owner@example.com');
  const manager = await createUser(pg, 'manager@example.com');
  const staff = await createUser(pg, 'staff@example.com');
  const shopId = await createShop(pg, owner, 'Diff shop');
  await addMember(pg, owner, shopId, manager, 'manager');
  await addMember(pg, owner, shopId, staff, 'staff');
  const db = openShopDatabase(SHOP_SCHEMA);
  const sql = nodeSql(db);
  const known = new Set([owner.id, manager.id, staff.id, shopId]);

  // Column types of the Postgres shop tables, for converting rows to the stored SQLite form.
  const types: Record<string, Record<string, string>> = {};
  const { rows: cols } = await pg.query<{ t: string; c: string; ty: string }>(
    `select c.relname as t, a.attname as c, format_type(a.atttypid, a.atttypmod) as ty
       from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('public', 'private') and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped`
  );
  for (const r of cols) (types[r.t] ??= {})[r.c] = r.ty;

  async function ctxFor(user: User | null): Promise<ShopCtx> {
    const { rows: shop } = await pg.query<{ status: string; timezone: string }>('select status, timezone from public.shops where id = $1', [shopId]);
    const member = user
      ? (await pg.query<{ role: ShopRole }>(`select role from public.shop_members where shop_id = $1 and user_id = $2 and status = 'active'`, [shopId, user.id])).rows[0]
      : undefined;
    const permissions = member
      ? (await pg.query<{ permission: string }>('select permission from private.role_permissions where role = $1', [member.role])).rows.map((r) => r.permission)
      : [];
    return {
      shopId,
      userId: user?.id ?? null,
      role: member?.role ?? null,
      permissions,
      shopActive: shop[0].status === 'active',
      timezone: shop[0].timezone,
      now: new Date().toISOString(),
    };
  }

  return {
    pg,
    db,
    sql,
    shopId,
    owner,
    manager,
    staff,
    known,
    ctxFor,
    async call(user, fn, args, inputs = {}) {
      collectIds(args, known);
      const now = Date.now();
      if (user === null) {
        // The Worker refuses calls without a session before they reach a shop, with the
        // message Postgres gave for a function the anonymous role may not execute.
        const pgOnly = await rpc(pg, null, fn, args).then(
          (data) => ({ data }) as Outcome,
          (err: { code?: string; message?: string }) => ({ error: { code: err.code ?? 'unknown', message: err.message ?? '' } }) as Outcome
        );
        return {
          pg: normalise(pgOnly, known, now) as Outcome,
          sq: { error: { code: '42501', message: `permission denied for function ${fn}` } },
          effects: [],
        };
      }
      let pgOut: Outcome;
      try {
        pgOut = { data: await rpc(pg, user, fn, args) };
      } catch (err) {
        const e = err as { code?: string; message?: string };
        pgOut = { error: { code: e.code ?? 'unknown', message: e.message ?? '' } };
      }
      const effects: ShopEffect[] = [];
      const call: ShopCall = { ctx: await ctxFor(user), effects, inputs };
      let sqOut: Outcome;
      try {
        sqOut = { data: JSON.parse(JSON.stringify(sql.transaction(() => SHOP_FUNCTIONS[fn](call, sql, args)))) };
      } catch (err) {
        if (!(err instanceof DbError)) throw err;
        sqOut = { error: { code: err.code, message: err.message } };
      }
      return {
        pg: normalise(pgOut, known, now) as Outcome,
        sq: normalise(sqOut, known, now) as Outcome,
        effects,
      };
    },
    async tables() {
      const now = Date.now();
      const pgOut: Record<string, unknown[]> = {};
      const sqOut: Record<string, unknown[]> = {};
      for (const [table, meta] of Object.entries(TABLES)) {
        if (meta.store !== 'shop') continue;
        const schema = table === 'low_stock_episodes' ? 'private' : 'public';
        const { rows } = await pg.query<{ line: string }>(
          `select to_jsonb(t)::text as line from ${schema}.${table} t where shop_id = $1`,
          [shopId]
        );
        pgOut[table] = sortRows(
          rows.map((r) => {
            const raw = parseExact(r.line);
            const stored: Record<string, unknown> = {};
            for (const [api, column] of meta.columns) {
              stored[column] = convertValue(`${schema}.${table}`, api, types[table][api], raw[api] as never);
            }
            return normalise(parseJsonColumns(table, stored), known, now);
          })
        );
        sqOut[table] = sortRows(
          sql.all(`SELECT * FROM ${table}`).map((r) => normalise(parseJsonColumns(table, r), known, now))
        );
      }
      return { pg: pgOut, sq: sqOut };
    },
    async close() {
      db.close();
      await pg.close();
    },
  };
}
