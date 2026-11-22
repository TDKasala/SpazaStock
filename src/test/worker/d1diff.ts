/**
 * Differential harness for the D1 functions: before every call the shared tables are copied from
 * Postgres into a fresh D1, so both sides start identical (including server-generated ids); then
 * the call runs on both and the results and every shared table are compared.
 */
import type { PGlite } from '@electric-sql/pglite';
import { createDatabase, rpc, type User } from '../db/harness';
import { freshD1 } from './nodeD1';
import { TABLES } from '../../../worker/db/columns';
import { DbError } from '../../../worker/db/errors';
import { ANON_FUNCTIONS, D1_FUNCTIONS } from '../../../worker/d1/functions';
import { convertValue, parseExact } from '../../../scripts/migrate-data/lib/transform';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX64 = /^[0-9a-f]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:?\d{2})?)$/;
const PRIVATE = new Set(['entitlement_catalog', 'platform_admins', 'platform_role_permissions', 'role_permissions']);

export type Outcome = { data: unknown } | { error: { code: string; message: string } };

/** Ids that existed before the call (or were passed in) stay; new ones are random on each side. */
function normalise(value: unknown, now: number, known: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((v) => normalise(v, now, known));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'created_at' || k === 'updated_at' || k === 'occurred_at') continue;
      out[k] = normalise(v, now, known);
    }
    return out;
  }
  if (typeof value === 'string') {
    if (UUID.test(value)) return known.has(value.toLowerCase()) ? value.toLowerCase() : '<new id>';
    if (HEX64.test(value)) return '<token>';
    if (ISO.test(value)) {
      const ms = Date.parse(value.replace(' ', 'T'));
      return Math.abs(ms - now) < 120_000 ? '<now>' : Math.abs(ms - now - 7 * 86_400_000) < 120_000 ? '<now+7d>' : new Date(ms).toISOString();
    }
  }
  return value;
}

export interface D1Pair {
  pg: PGlite;
  call(user: User | null, fn: string, args?: Record<string, unknown>): Promise<{ pg: Outcome; d1: Outcome; tables: { pg: Record<string, unknown[]>; d1: Record<string, unknown[]> } }>;
  close(): Promise<void>;
}

/** A fresh D1 holding a copy of the Postgres shared tables and users (see createD1Pair). */
export async function mirrorD1(pg: PGlite) {
  return (await d1Tools(pg)).mirror();
}

async function d1Tools(pg: PGlite) {
  const types: Record<string, Record<string, string>> = {};
  const { rows: cols } = await pg.query<{ t: string; c: string; ty: string }>(
    `select c.relname as t, a.attname as c, format_type(a.atttypid, a.atttypmod) as ty
       from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('public', 'private') and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped`
  );
  for (const r of cols) (types[r.t] ??= {})[r.c] = r.ty;
  const d1Tables = Object.entries(TABLES).filter(([, m]) => m.store === 'd1');

  async function pgRows(table: string) {
    const schema = PRIVATE.has(table) ? 'private' : 'public';
    const meta = TABLES[table];
    const { rows } = await pg.query<{ line: string }>(`select to_jsonb(t)::text as line from ${schema}.${table} t`);
    return rows.map((r) => {
      const raw = parseExact(r.line);
      const stored: Record<string, string | number | null> = {};
      for (const [api, column] of meta.columns) stored[column] = convertValue(`${schema}.${table}`, api, types[table][api], raw[api] as never);
      return stored;
    });
  }

  async function mirror() {
    const d1 = freshD1();
    d1.db.exec('PRAGMA foreign_keys = OFF');
    const { rows: users } = await pg.query<{ id: string; email: string; email_confirmed_at: string | null; created_at: string; meta: string }>(
      'select id, email, email_confirmed_at, created_at, raw_user_meta_data::text as meta from auth.users'
    );
    for (const u of users) {
      d1.db
        .prepare('insert into users (id, email, email_confirmed_at, created_at, updated_at, metadata) values (?, ?, ?, ?, ?, ?)')
        .run(u.id, u.email.toLowerCase(), u.email_confirmed_at ? new Date(u.email_confirmed_at).toISOString() : null, new Date(u.created_at).toISOString(), new Date(u.created_at).toISOString(), u.meta);
    }
    for (const [table] of d1Tables) {
      for (const row of await pgRows(table)) {
        const c = Object.keys(row);
        d1.db.prepare(`insert or replace into ${table} (${c.join(', ')}) values (${c.map(() => '?').join(', ')})`).run(...(c.map((k) => row[k]) as never[]));
      }
    }
    d1.db.exec('PRAGMA foreign_keys = ON');
    return d1;
  }

  const parseJson = (table: string, row: Record<string, unknown>) => {
    const out = { ...row };
    for (const [, column, kind] of TABLES[table].columns) if (kind === 'json' && typeof out[column] === 'string') out[column] = JSON.parse(out[column] as string);
    return out;
  };
  const sort = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).sort();

  return { mirror, pgRows, d1Tables, parseJson, sort };
}

export async function createD1Pair(): Promise<D1Pair> {
  const pg = await createDatabase();
  const { mirror, pgRows, d1Tables, parseJson, sort } = await d1Tools(pg);
  return {
    pg,
    async call(user, fn, args = {}) {
      const d1 = await mirror();
      const now = Date.now();
      const known = new Set<string>();
      const collect = (v: unknown): void => {
        if (Array.isArray(v)) v.forEach(collect);
        else if (v && typeof v === 'object') Object.values(v).forEach(collect);
        else if (typeof v === 'string' && UUID.test(v)) known.add(v.toLowerCase());
      };
      collect(args);
      for (const [table] of d1Tables) collect(await pgRows(table));
      collect((await pg.query('select id from auth.users')).rows);
      let pgOut: Outcome;
      // PostgREST sends arrays of plain values as Postgres arrays (the harness would send JSON text).
      const pgArgs = Object.fromEntries(
        Object.entries(args).map(([k, v]) =>
          Array.isArray(v) && v.every((x) => typeof x === 'number') ? [k, `{${v.join(',')}}`] : [k, v]
        )
      );
      try {
        const data = await rpc(pg, user, fn, pgArgs);
        // A void function comes back as '' from the harness and null from PostgREST.
        pgOut = { data: data === ('' as unknown) ? null : data };
      } catch (err) {
        const e = err as { code?: string; message?: string };
        pgOut = { error: { code: e.code ?? 'unknown', message: e.message ?? '' } };
      }
      let d1Out: Outcome;
      if (user === null && !ANON_FUNCTIONS.has(fn)) {
        // The Worker refuses these before they run, with Postgres's message for the anon role.
        d1Out = { error: { code: '42501', message: `permission denied for function ${fn}` } };
      } else try {
        const ctx = { userId: user?.id ?? null, email: user?.email ?? null, now: new Date().toISOString() };
        const data = await D1_FUNCTIONS[fn](d1, ctx, args);
        // rpc() returns a record function's row as its single value; void returns null.
        d1Out = { data: JSON.parse(JSON.stringify(data ?? null)) };
      } catch (err) {
        if (!(err instanceof DbError)) throw err;
        d1Out = { error: { code: err.code, message: err.message } };
      }
      const tables = { pg: {} as Record<string, unknown[]>, d1: {} as Record<string, unknown[]> };
      for (const [table] of d1Tables) {
        tables.pg[table] = sort((await pgRows(table)).map((r) => normalise(parseJson(table, r), now, known)));
        tables.d1[table] = sort(d1.db.prepare(`select * from ${table}`).all().map((r) => normalise(parseJson(table, { ...r }), now, known)));
      }
      d1.db.close();
      return { pg: normalise(pgOut, now, known) as Outcome, d1: normalise(d1Out, now, known) as Outcome, tables };
    },
    async close() {
      await pg.close();
    },
  };
}
