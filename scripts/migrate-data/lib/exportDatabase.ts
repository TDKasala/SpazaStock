/**
 * Read-only export of the SpazaStock Postgres data (Supabase) for the move to Cloudflare.
 *
 * Every row is written exactly as Postgres renders it with `to_jsonb(row)::text`: numerics keep
 * their exact decimal text, timestamps keep their offset, uuids stay as they are. Nothing is
 * parsed or rounded here; conversion to D1 / Durable Object types happens in the loader.
 *
 * The caller runs this inside one REPEATABLE READ, READ ONLY transaction, so every table and
 * every check in the manifest comes from the same snapshot.
 */

/** Runs one SQL statement and returns its rows. Adapters exist for postgres.js and PGlite. */
export type Query = (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

/** Where exported data goes. The CLI writes files; tests keep it in memory. */
export interface Sink {
  appendLines(path: string, lines: string[]): Promise<void>;
  writeJson(path: string, value: unknown): Promise<void>;
}

export const EXPORT_SCHEMAS = ['public', 'private'] as const;

/** Temporary data rebuilt on Cloudflare; see docs/data-migration.md section 2. */
export const SKIPPED_TABLES = new Set(['public.product_lookup_rate']);

const PAGE_SIZE = 1000;

/** Only the columns the new auth needs. The bcrypt hash is checked on first sign-in, then replaced. */
const USER_COLUMNS = [
  'id',
  'email',
  'encrypted_password',
  'email_confirmed_at',
  'created_at',
  'updated_at',
  'last_sign_in_at',
  'raw_user_meta_data',
] as const;

export interface TableInfo {
  /** schema.table */
  name: string;
  schema: string;
  table: string;
  primaryKey: string[];
  columns: { name: string; type: string; nullable: boolean }[];
  /** Other exported tables this one references (excluding itself). */
  dependsOn: string[];
}

export interface ExportManifest {
  format: 'spazastock-export/1';
  startedAt: string;
  finishedAt: string;
  source: { serverVersion: string; migrations: string[] };
  /** Load order: every table comes after the tables it references. */
  tables: { name: string; file: string; rows: number; primaryKey: string[]; columns: TableInfo['columns']; dependsOn: string[] }[];
  skippedTables: string[];
  /** Tables whose foreign keys form a cycle; the loader must defer those constraints. */
  cyclicTables: string[];
  users: { file: string; rows: number; columns: readonly string[] };
  checks: Record<string, unknown>;
}

function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function qualified(schema: string, table: string): string {
  return `${ident(schema)}.${ident(table)}`;
}

export async function discoverTables(query: Query): Promise<TableInfo[]> {
  const tables = await query(
    `select c.oid::bigint as oid, n.nspname as schema, c.relname as table
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p') and n.nspname = any($1::text[])
      order by n.nspname, c.relname`,
    [EXPORT_SCHEMAS as unknown as string[]]
  );

  const columns = await query(
    `select n.nspname as schema, c.relname as table, a.attname as name,
            format_type(a.atttypid, a.atttypmod) as type, not a.attnotnull as nullable
       from pg_attribute a
       join pg_class c on c.oid = a.attrelid
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = any($1::text[]) and c.relkind in ('r', 'p') and a.attnum > 0 and not a.attisdropped
      order by n.nspname, c.relname, a.attnum`,
    [EXPORT_SCHEMAS as unknown as string[]]
  );

  const keys = await query(
    `select n.nspname as schema, c.relname as table, a.attname as name, k.ord as ord
       from pg_index i
       join pg_class c on c.oid = i.indrelid
       join pg_namespace n on n.oid = c.relnamespace
       cross join lateral unnest(i.indkey) with ordinality as k(attnum, ord)
       join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
      where i.indisprimary and n.nspname = any($1::text[])
      order by n.nspname, c.relname, k.ord`,
    [EXPORT_SCHEMAS as unknown as string[]]
  );

  const foreignKeys = await query(
    `select sn.nspname || '.' || sc.relname as from_table, tn.nspname || '.' || tc.relname as to_table
       from pg_constraint f
       join pg_class sc on sc.oid = f.conrelid
       join pg_namespace sn on sn.oid = sc.relnamespace
       join pg_class tc on tc.oid = f.confrelid
       join pg_namespace tn on tn.oid = tc.relnamespace
      where f.contype = 'f' and sn.nspname = any($1::text[])`,
    [EXPORT_SCHEMAS as unknown as string[]]
  );

  const byName = new Map<string, TableInfo>();
  for (const row of tables) {
    const name = `${row.schema}.${row.table}`;
    if (SKIPPED_TABLES.has(name)) continue;
    byName.set(name, {
      name,
      schema: String(row.schema),
      table: String(row.table),
      primaryKey: [],
      columns: [],
      dependsOn: [],
    });
  }
  for (const row of columns) {
    byName.get(`${row.schema}.${row.table}`)?.columns.push({
      name: String(row.name),
      type: String(row.type),
      nullable: Boolean(row.nullable),
    });
  }
  for (const row of keys) byName.get(`${row.schema}.${row.table}`)?.primaryKey.push(String(row.name));
  for (const row of foreignKeys) {
    const from = byName.get(String(row.from_table));
    const to = String(row.to_table);
    if (from && to !== from.name && byName.has(to) && !from.dependsOn.includes(to)) from.dependsOn.push(to);
  }
  for (const table of byName.values()) table.dependsOn.sort();

  return [...byName.values()];
}

/** Parents before children. Tables in a foreign-key cycle go last, alphabetically, and are reported. */
export function loadOrder(tables: TableInfo[]): { ordered: TableInfo[]; cyclic: string[] } {
  const remaining = new Map(tables.map((t) => [t.name, t]));
  const done = new Set<string>();
  const ordered: TableInfo[] = [];

  for (;;) {
    const ready = [...remaining.values()]
      .filter((t) => t.dependsOn.every((d) => done.has(d)))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (ready.length === 0) break;
    for (const t of ready) {
      ordered.push(t);
      done.add(t.name);
      remaining.delete(t.name);
    }
  }

  const cyclic = [...remaining.keys()].sort();
  for (const name of cyclic) ordered.push(remaining.get(name)!);
  return { ordered, cyclic };
}

function orderBy(table: TableInfo): string {
  // Without a primary key, ordering by the whole row is still deterministic.
  return table.primaryKey.length > 0 ? table.primaryKey.map(ident).join(', ') : 't::text';
}

async function exportRows(
  query: Query,
  sink: Sink,
  file: string,
  from: string,
  select: string,
  order: string
): Promise<number> {
  // Every table gets a file, empty or not, so the loader can tell "no rows" from "missing".
  await sink.appendLines(file, []);
  let offset = 0;
  for (;;) {
    const rows = await query(`select ${select} as line from ${from} t order by ${order} limit $1 offset $2`, [
      PAGE_SIZE,
      offset,
    ]);
    if (rows.length === 0) break;
    await sink.appendLines(
      file,
      rows.map((r) => String(r.line))
    );
    offset += rows.length;
    if (rows.length < PAGE_SIZE) break;
  }
  return offset;
}

async function one(query: Query, text: string): Promise<unknown> {
  const rows = await query(text);
  return rows[0]?.value ?? null;
}

/**
 * Totals the loader must reproduce exactly. Sums are cast to text so no value is rounded on the
 * way through JavaScript.
 */
export async function computeChecks(query: Query): Promise<Record<string, unknown>> {
  return {
    users: await one(
      query,
      `select jsonb_build_object('total', count(*), 'confirmed', count(email_confirmed_at),
              'with_password', count(nullif(encrypted_password, ''))) as value from auth.users`
    ),
    shops: await one(
      query,
      `select coalesce(jsonb_object_agg(s.id, jsonb_build_object(
          'status', s.status,
          'members', (select count(*) from public.shop_members m where m.shop_id = s.id),
          'products', (select count(*) from public.products p where p.shop_id = s.id),
          'archived_products', (select count(*) from public.products p where p.shop_id = s.id and p.archived_at is not null),
          'batches', (select count(*) from public.stock_batches b where b.shop_id = s.id),
          'units_in_stock', (select coalesce(sum(b.quantity), 0)::text from public.stock_batches b where b.shop_id = s.id),
          'movements', (select count(*) from public.stock_movements m where m.shop_id = s.id),
          'movement_units', (select coalesce(sum(m.quantity_delta), 0)::text from public.stock_movements m where m.shop_id = s.id),
          'sales', (select count(*) from public.sales x where x.shop_id = s.id),
          'sales_total', (select coalesce(sum(x.total_amount), 0)::text from public.sales x where x.shop_id = s.id),
          'sale_items', (select count(*) from public.sale_items i where i.shop_id = s.id),
          'voided_units', (select coalesce(sum(i.voided_quantity), 0)::text from public.sale_items i where i.shop_id = s.id)
        ) order by s.id), '{}'::jsonb) as value
       from public.shops s`
    ),
    ledger_out_of_balance: await one(
      query,
      `with b as (select product_id, sum(quantity) q from public.stock_batches group by 1),
            m as (select product_id, sum(quantity_delta) d from public.stock_movements group by 1)
       select (count(*) filter (where coalesce(b.q, 0) <> coalesce(m.d, 0)))::int as value
         from b full join m using (product_id)`
    ),
    catalog: await one(
      query,
      `select jsonb_build_object(
          'products', (select count(*) from public.catalog_products),
          'barcodes', (select count(*) from public.catalog_barcodes),
          'orphan_barcodes', (select count(*) from public.catalog_barcodes b
                               where not exists (select 1 from public.catalog_products p where p.id = b.catalog_product_id))
        ) as value`
    ),
    images: await one(
      query,
      `select jsonb_build_object(
          'objects', (select count(*) from storage.objects),
          'bytes', (select coalesce(sum((metadata ->> 'size')::bigint), 0)::text from storage.objects),
          'product_paths', (select count(distinct image_path) from public.products where image_path is not null),
          'catalog_paths', (select count(distinct image_path) from public.catalog_products where image_path is not null),
          'missing_objects', (select count(*) from (
              select image_path from public.products where image_path is not null
              union select image_path from public.catalog_products where image_path is not null) r
            where not exists (select 1 from storage.objects o where o.name = r.image_path))
        ) as value`
    ),
  };
}

async function sourceInfo(query: Query): Promise<ExportManifest['source']> {
  const version = await query('select version() as value');
  const hasMigrations = await query(
    `select to_regclass('supabase_migrations.schema_migrations') is not null as value`
  );
  const migrations = hasMigrations[0]?.value
    ? (await query('select version from supabase_migrations.schema_migrations order by version')).map((r) =>
        String(r.version)
      )
    : [];
  return { serverVersion: String(version[0]?.value ?? ''), migrations };
}

export interface ExportOptions {
  /** Called after each table, for progress output. Never receives row data. */
  onTable?: (name: string, rows: number) => void;
  now?: () => Date;
}

export async function exportDatabase(query: Query, sink: Sink, options: ExportOptions = {}): Promise<ExportManifest> {
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();

  const source = await sourceInfo(query);
  const { ordered, cyclic } = loadOrder(await discoverTables(query));

  const userFile = 'auth/users.jsonl';
  const userSelect = `jsonb_build_object(${USER_COLUMNS.map((c) => `'${c}', t.${ident(c)}`).join(', ')})::text`;
  const userRows = await exportRows(query, sink, userFile, 'auth.users', userSelect, 't.id');
  options.onTable?.('auth.users', userRows);

  const tables: ExportManifest['tables'] = [];
  for (const table of ordered) {
    const file = `db/${table.name}.jsonl`;
    const rows = await exportRows(
      query,
      sink,
      file,
      qualified(table.schema, table.table),
      'to_jsonb(t)::text',
      orderBy(table)
    );
    tables.push({
      name: table.name,
      file,
      rows,
      primaryKey: table.primaryKey,
      columns: table.columns,
      dependsOn: table.dependsOn,
    });
    options.onTable?.(table.name, rows);
  }

  const checks = await computeChecks(query);

  const manifest: ExportManifest = {
    format: 'spazastock-export/1',
    startedAt,
    finishedAt: now().toISOString(),
    source,
    tables,
    skippedTables: [...SKIPPED_TABLES].sort(),
    cyclicTables: cyclic,
    users: { file: userFile, rows: userRows, columns: USER_COLUMNS },
    checks,
  };
  return manifest;
}

export interface StorageObjectRow {
  bucket: string;
  name: string;
  size: number | null;
  mimetype: string | null;
}

/** Same snapshot as the tables: the list of files to download afterwards. */
export async function listStorageObjects(query: Query): Promise<StorageObjectRow[]> {
  const rows = await query(
    `select bucket_id as bucket, name, (metadata ->> 'size')::bigint as size, metadata ->> 'mimetype' as mimetype
       from storage.objects order by bucket_id, name`
  );
  return rows.map((r) => ({
    bucket: String(r.bucket),
    name: String(r.name),
    size: r.size == null ? null : Number(r.size),
    mimetype: r.mimetype == null ? null : String(r.mimetype),
  }));
}
