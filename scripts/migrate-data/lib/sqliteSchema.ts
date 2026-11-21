/**
 * Generates the SQLite schemas for Cloudflare from the live Postgres catalog:
 *   - the shared D1 database (migrations/d1/0001_initial.sql)
 *   - the per-shop Durable Object database (worker/shop/schema.sql)
 *
 * Generated from the real migrations so the two cannot drift before cutover. What SQLite cannot
 * express (regex CHECKs, trigram indexes, foreign keys between the two stores) is listed in a
 * comment at the end of each file: the Worker code must enforce those rules itself.
 *
 * Conventions shared with the loader (transform.ts):
 *   uuid, text, date, jsonb, arrays  → TEXT (jsonb and arrays as JSON text)
 *   timestamptz                      → TEXT, ISO-8601 UTC with milliseconds: 2026-11-21T14:00:00.123Z
 *   boolean                          → INTEGER 0/1
 *   integer, smallint, bigint        → INTEGER
 *   double precision, other decimals → REAL
 *   money numeric                    → INTEGER cents, column renamed <name>_cents
 * Tables are STRICT, so SQLite rejects a value of the wrong type.
 */
import { DatabaseSync } from 'node:sqlite';
import { discoverTables, loadOrder, type Query, type TableInfo } from './exportDatabase.ts';
import {
  DECIMAL_COLUMNS,
  NOT_MIGRATED,
  isMoney,
  sqliteColumnName,
  sqliteTableName,
  storeOf,
  type Store,
} from './partition.ts';

export const NOW_ISO = `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

export interface SchemaNote {
  table: string;
  kind: 'check' | 'index' | 'foreign_key' | 'default';
  detail: string;
  reason: string;
}

export interface GeneratedSchemas {
  d1: string;
  shop: string;
  notes: Record<Store, SchemaNote[]>;
  /** Column type of every migrated column, for the loader: `schema.table` → column → pg type. */
  columnTypes: Record<string, Record<string, string>>;
}

interface Catalog {
  defaults: Map<string, string>;
  checks: Map<string, string[]>;
  foreignKeys: Map<string, { target: string; def: string }[]>;
  indexes: Map<string, string[]>;
}

const key = (table: string, column: string) => `${table}.${column}`;

async function readCatalog(query: Query): Promise<Catalog> {
  const schemas = ['public', 'private'];
  const defaults = new Map<string, string>();
  for (const r of await query(
    `select n.nspname || '.' || c.relname as tbl, a.attname as col, pg_get_expr(d.adbin, d.adrelid) as expr
       from pg_attrdef d
       join pg_class c on c.oid = d.adrelid
       join pg_namespace n on n.oid = c.relnamespace
       join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
      where n.nspname = any($1::text[])`,
    [schemas]
  )) {
    defaults.set(key(String(r.tbl), String(r.col)), String(r.expr));
  }

  const checks = new Map<string, string[]>();
  const foreignKeys = new Map<string, { target: string; def: string }[]>();
  for (const r of await query(
    `select n.nspname || '.' || c.relname as tbl, f.contype as type, pg_get_constraintdef(f.oid) as def,
            tn.nspname || '.' || tc.relname as target
       from pg_constraint f
       join pg_class c on c.oid = f.conrelid
       join pg_namespace n on n.oid = c.relnamespace
       left join pg_class tc on tc.oid = f.confrelid
       left join pg_namespace tn on tn.oid = tc.relnamespace
      where f.contype in ('c', 'f') and n.nspname = any($1::text[])
      order by 1, f.conname`,
    [schemas]
  )) {
    const table = String(r.tbl);
    if (r.type === 'c') checks.set(table, [...(checks.get(table) ?? []), String(r.def)]);
    else foreignKeys.set(table, [...(foreignKeys.get(table) ?? []), { target: String(r.target), def: String(r.def) }]);
  }

  const indexes = new Map<string, string[]>();
  for (const r of await query(
    `select i.schemaname || '.' || i.tablename as tbl, i.indexdef as def
       from pg_indexes i
      where i.schemaname = any($1::text[])
        and not exists (select 1 from pg_constraint p
                         join pg_class ic on ic.oid = p.conindid
                        where p.contype = 'p' and ic.relname = i.indexname)
      order by i.indexname`,
    [schemas]
  )) {
    const table = String(r.tbl);
    indexes.set(table, [...(indexes.get(table) ?? []), String(r.def)]);
  }

  return { defaults, checks, foreignKeys, indexes };
}

export function sqliteType(table: string, column: string, pgType: string): 'TEXT' | 'INTEGER' | 'REAL' {
  if (pgType.endsWith('[]')) return 'TEXT';
  if (['uuid', 'text', 'date', 'jsonb', 'json', 'timestamp with time zone'].includes(pgType)) return 'TEXT';
  if (pgType.startsWith('character varying')) return 'TEXT';
  if (['integer', 'smallint', 'bigint', 'boolean'].includes(pgType)) return 'INTEGER';
  if (pgType === 'double precision' || pgType === 'real') return 'REAL';
  if (pgType.startsWith('numeric')) {
    if (isMoney(table, column)) return 'INTEGER';
    if (DECIMAL_COLUMNS[table]?.includes(column)) return 'REAL';
    throw new Error(
      `${table}.${column} is numeric but neither a money nor a decimal column; add it to partition.ts.`
    );
  }
  throw new Error(`No SQLite mapping for ${table}.${column} of type ${pgType}.`);
}

/** Returns the SQLite DEFAULT clause, null for none, or throws on an expression it does not know. */
export function sqliteDefault(expr: string): string | null {
  const literal = /^'((?:[^']|'')*)'::(?:text|character varying)$/.exec(expr);
  if (literal) return `'${literal[1]}'`;
  const json = /^'((?:[^']|'')*)'::jsonb?$/.exec(expr);
  if (json) return `'${json[1]}'`;
  const array = /^'\{([^}]*)\}'::\w+\[\]$/.exec(expr);
  if (array) return `'[${array[1]}]'`;
  if (/^-?\d+(\.\d+)?$/.test(expr)) return expr;
  if (expr === 'true') return '1';
  if (expr === 'false') return '0';
  if (expr === 'now()') return NOW_ISO;
  // Ids and actors are supplied by the Worker, which knows the caller.
  if (expr === 'gen_random_uuid()' || expr === 'auth.uid()') return null;
  throw new Error(`No SQLite default for expression: ${expr}`);
}

function quoteIdent(name: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

/**
 * Rewrites a Postgres boolean expression (CHECK or index predicate) for SQLite, or returns null
 * when it uses something SQLite lacks (regular expressions, schema functions).
 */
export function translateExpression(expr: string, table: string, columns: string[]): string | null {
  let out = expr
    .replace(/!~~/g, ' NOT LIKE ')
    .replace(/~~/g, ' LIKE ');
  if (/~|private\.|public\.|similar to/i.test(out)) return null;

  out = out
    .replace(/= ANY \(ARRAY\[([^\]]*)\]\)/g, 'IN ($1)')
    .replace(/'(-?\d+(?:\.\d+)?)'::(?:integer|numeric|bigint|smallint|double precision)/g, '$1')
    .replace(
      /::(?:text|integer|numeric|bigint|smallint|double precision|jsonb|date|timestamp with time zone|uuid|boolean)(?:\[\])?/g,
      ''
    )
    .replace(/\bchar_length\(/g, 'length(')
    .replace(/\bbtrim\(/g, 'trim(');

  for (const column of columns) {
    if (isMoney(table, column)) out = out.replace(new RegExp(`\\b${column}\\b`, 'g'), sqliteColumnName(table, column));
  }
  return out;
}

/** Splits on commas that are not inside parentheses or quotes. */
function splitTopLevel(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = '';
  for (const ch of list) {
    if (ch === "'") quoted = !quoted;
    if (!quoted && ch === '(') depth++;
    if (!quoted && ch === ')') depth--;
    if (!quoted && depth === 0 && ch === ',') {
      parts.push(current.trim());
      current = '';
    } else current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

interface ParsedIndex {
  unique: boolean;
  name: string;
  method: string;
  items: string[];
  nullsNotDistinct: boolean;
  where: string | null;
}

export function parseIndexDef(def: string): ParsedIndex {
  const head = /^CREATE (UNIQUE )?INDEX (\S+) ON (\S+) USING (\w+) \(/.exec(def);
  if (!head) throw new Error(`Unrecognised index definition: ${def}`);
  let i = head[0].length;
  let depth = 1;
  const start = i;
  for (; i < def.length && depth > 0; i++) {
    if (def[i] === '(') depth++;
    if (def[i] === ')') depth--;
  }
  const items = splitTopLevel(def.slice(start, i - 1));
  let rest = def.slice(i).trim();
  const nullsNotDistinct = rest.startsWith('NULLS NOT DISTINCT');
  if (nullsNotDistinct) rest = rest.slice('NULLS NOT DISTINCT'.length).trim();
  let where: string | null = null;
  if (rest.startsWith('WHERE ')) where = rest.slice('WHERE '.length).trim();
  else if (rest) throw new Error(`Unrecognised index suffix in: ${def}`);
  return { unique: Boolean(head[1]), name: head[2], method: head[4], items, nullsNotDistinct, where };
}

interface TableDdl {
  table: string;
  sql: string;
  indexes: string[];
}

function buildTable(
  info: TableInfo,
  store: Store,
  catalog: Catalog,
  notes: SchemaNote[],
  probe: DatabaseSync
): TableDdl {
  const name = sqliteTableName(info.name);
  const columnNames = info.columns.map((c) => c.name);
  const lines: string[] = [];

  for (const column of info.columns) {
    const type = sqliteType(info.name, column.name, column.type);
    let line = `  ${quoteIdent(sqliteColumnName(info.name, column.name))} ${type}`;
    if (!column.nullable) line += ' NOT NULL';
    const expr = catalog.defaults.get(key(info.name, column.name));
    if (expr !== undefined) {
      const value = sqliteDefault(expr);
      if (value === null) {
        notes.push({ table: name, kind: 'default', detail: `${column.name} DEFAULT ${expr}`, reason: 'supplied by the Worker' });
      } else {
        line += ` DEFAULT ${value}`;
      }
    }
    if (column.type === 'boolean') line += ` CHECK (${quoteIdent(column.name)} IN (0, 1))`;
    lines.push(line);
  }

  if (info.primaryKey.length) {
    lines.push(`  PRIMARY KEY (${info.primaryKey.map((c) => quoteIdent(sqliteColumnName(info.name, c))).join(', ')})`);
  }

  for (const fk of catalog.foreignKeys.get(info.name) ?? []) {
    const target = fk.target;
    const targetStore: Store | 'skip' =
      target === 'auth.users' ? 'd1' : NOT_MIGRATED.has(target) ? 'skip' : storeOf(target);
    const parsed = /^FOREIGN KEY \(([^)]+)\) REFERENCES \S+?\(([^)]+)\)(.*)$/.exec(fk.def);
    if (!parsed) throw new Error(`Unrecognised foreign key on ${info.name}: ${fk.def}`);
    if (targetStore !== store) {
      notes.push({
        table: name,
        kind: 'foreign_key',
        detail: `(${parsed[1]}) → ${sqliteTableName(target)}(${parsed[2]})`,
        reason: targetStore === 'skip' ? 'target is not migrated' : `target lives in ${targetStore === 'd1' ? 'D1' : 'the shop object'}`,
      });
      continue;
    }
    const cols = parsed[1].split(',').map((c) => quoteIdent(sqliteColumnName(info.name, c.trim())));
    const targetCols = parsed[2].split(',').map((c) => quoteIdent(sqliteColumnName(target, c.trim())));
    lines.push(
      `  FOREIGN KEY (${cols.join(', ')}) REFERENCES ${sqliteTableName(target)} (${targetCols.join(', ')})${parsed[3]}`
    );
  }

  const tryCreate = (body: string[]): string | null => {
    try {
      probe.exec(`DROP TABLE IF EXISTS __probe; CREATE TABLE __probe (\n${body.join(',\n')}\n) STRICT;`);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };
  const baseError = tryCreate(lines);
  if (baseError) throw new Error(`SQLite rejected the columns of ${name}: ${baseError}`);

  for (const def of catalog.checks.get(info.name) ?? []) {
    const inner = /^CHECK \((.*)\)$/s.exec(def)?.[1];
    const translated = inner ? translateExpression(inner, info.name, columnNames) : null;
    if (!translated) {
      notes.push({ table: name, kind: 'check', detail: def, reason: 'uses a regex or a database function' });
      continue;
    }
    const candidate = `  CHECK (${translated})`;
    const error = tryCreate([...lines, candidate]);
    if (error) {
      notes.push({ table: name, kind: 'check', detail: def, reason: `SQLite: ${error}` });
      continue;
    }
    lines.push(candidate);
  }

  const indexes: string[] = [];
  for (const def of catalog.indexes.get(info.name) ?? []) {
    const index = parseIndexDef(def);
    if (index.method !== 'btree') {
      notes.push({ table: name, kind: 'index', detail: def, reason: `${index.method} index (catalog search moves to FTS5)` });
      continue;
    }
    const nullable = new Set(info.columns.filter((c) => c.nullable).map((c) => c.name));
    const items = index.items.map((item) => {
      const bare = /^(\w+)( DESC| ASC)?$/.exec(item);
      if (bare && index.nullsNotDistinct && nullable.has(bare[1])) {
        // NULLS NOT DISTINCT: a blob never equals a number or text, so NULLs collide like Postgres.
        return `ifnull(${quoteIdent(bare[1])}, x'00')`;
      }
      return translateExpression(item, info.name, columnNames);
    });
    const where = index.where === null ? null : translateExpression(index.where, info.name, columnNames);
    if (items.some((i) => i === null) || (index.where !== null && where === null)) {
      notes.push({ table: name, kind: 'index', detail: def, reason: 'expression SQLite cannot express' });
      continue;
    }
    const sql = `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${index.name} ON ${name} (${items.join(', ')})${
      where ? ` WHERE ${where}` : ''
    };`;
    indexes.push(sql);
  }

  return { table: name, sql: `CREATE TABLE ${name} (\n${lines.join(',\n')}\n) STRICT;`, indexes };
}

/** The new auth's user table. Ids, emails and bcrypt hashes come from Supabase auth.users. */
export const USERS_DDL = `CREATE TABLE users (
  id TEXT NOT NULL,
  email TEXT NOT NULL,
  password_hash TEXT,
  password_kind TEXT CHECK (password_kind IN ('bcrypt', 'pbkdf2')),
  email_confirmed_at TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW_ISO},
  updated_at TEXT NOT NULL DEFAULT ${NOW_ISO},
  last_sign_in_at TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (id),
  CHECK ((password_hash IS NULL) = (password_kind IS NULL)),
  CHECK (email = lower(trim(email)))
) STRICT;
CREATE UNIQUE INDEX users_email_key ON users (email);`;

function render(title: string, intro: string[], tables: TableDdl[], notes: SchemaNote[], extra: string[] = []): string {
  const out: string[] = [
    `-- ${title}`,
    '-- Generated by `npm run data:schema` from supabase/migrations. Do not edit by hand before the',
    '-- cutover: change the generator or partition.ts and regenerate. After cutover this file is frozen',
    '-- and later changes go in new migrations.',
    ...intro.map((l) => `-- ${l}`),
    '',
    ...extra,
  ];
  for (const t of tables) {
    out.push(t.sql, ...t.indexes, '');
  }
  if (notes.length) {
    out.push('-- Not expressible in SQLite. The Worker must enforce these rules:');
    for (const n of notes) out.push(`--   ${n.table} [${n.kind}] ${n.detail.replace(/\s+/g, ' ')} (${n.reason})`);
  }
  return `${out.join('\n').trimEnd()}\n`;
}

export async function generateSchemas(query: Query): Promise<GeneratedSchemas> {
  const catalog = await readCatalog(query);
  const discovered = (await discoverTables(query)).filter((t) => !NOT_MIGRATED.has(t.name));
  const { ordered } = loadOrder(discovered);
  const probe = new DatabaseSync(':memory:');

  const notes: Record<Store, SchemaNote[]> = { d1: [], shop: [] };
  const ddl: Record<Store, TableDdl[]> = { d1: [], shop: [] };
  const columnTypes: GeneratedSchemas['columnTypes'] = {};
  for (const info of ordered) {
    const store = storeOf(info.name);
    ddl[store].push(buildTable(info, store, catalog, notes[store], probe));
    columnTypes[info.name] = Object.fromEntries(info.columns.map((c) => [c.name, c.type]));
  }
  probe.close();

  return {
    d1: render(
      'SpazaStock shared D1 database: identity, shops, membership, catalog, plans, notifications, administration.',
      ['Shop ledgers (products, stock, sales, alerts, wholesale) live in each shop\'s Durable Object instead.'],
      ddl.d1,
      notes.d1,
      [USERS_DDL, '']
    ),
    shop: render(
      "SpazaStock shop Durable Object database: one SQLite database per shop, holding that shop's ledger.",
      ['Every row still carries shop_id, equal to the object\'s shop, so rows stay self-describing.'],
      ddl.shop,
      notes.shop
    ),
    notes,
    columnTypes,
  };
}
