/**
 * Where each Postgres table lives on Cloudflare (docs/cloudflare-migration.md, option A).
 *
 * - `shop`: the shop's own Durable Object (SQLite). One database per shop, so writes to a shop
 *   happen one at a time and tenant isolation is structural instead of RLS.
 * - `d1`:   the shared D1 database: identity, shops index, membership, shared catalog, plans,
 *   notifications/push and platform administration.
 *
 * Every table the export finds must be listed here; the schema generator fails on an unknown one,
 * so a new migration cannot be forgotten.
 */

export type Store = 'd1' | 'shop';

export const SHOP_TABLES = new Set([
  'public.products',
  'public.product_packagings',
  'public.product_barcodes',
  'public.stock_batches',
  'public.stock_movements',
  'public.stock_discrepancies',
  'public.sales',
  'public.sale_items',
  'public.sale_item_voids',
  'public.expiry_alerts',
  'public.expiry_resolutions',
  'public.low_stock_dismissals',
  'private.low_stock_episodes',
  'public.wholesalers',
  'public.wholesale_orders',
  'public.wholesale_order_items',
  'public.wholesale_order_receipts',
  'public.wholesale_order_receipt_lines',
]);

export const D1_TABLES = new Set([
  'public.shops',
  'public.shop_members',
  'public.membership_events',
  'public.profiles',
  'public.notifications',
  'public.push_subscriptions',
  'public.subscriptions',
  'public.subscription_events',
  'public.plans',
  'public.plan_entitlements',
  'public.platform_features',
  'public.platform_audit_log',
  'public.sync_failure_reports',
  'public.catalog_products',
  'public.catalog_barcodes',
  'public.catalog_corrections',
  'public.product_lookup_cache',
  'private.entitlement_catalog',
  'private.platform_admins',
  'private.platform_role_permissions',
  'private.role_permissions',
]);

/** Rebuilt on Cloudflare, never copied (matches SKIPPED_TABLES in exportDatabase.ts). */
export const NOT_MIGRATED = new Set(['public.product_lookup_rate']);

/**
 * Money columns become whole cents in a column renamed `<name>_cents`, so ported code cannot
 * mistake cents for rands. Every other `numeric` column must be listed in DECIMAL_COLUMNS.
 */
export const MONEY_COLUMNS: Record<string, string[]> = {
  'public.products': ['buying_price', 'selling_price'],
  'public.product_packagings': ['selling_price'],
  'public.stock_batches': ['cost_price_per_unit'],
  'public.sales': ['total_amount'],
  'public.sale_items': ['unit_price', 'line_total'],
  'public.wholesale_order_items': ['estimated_unit_cost'],
};

/** Non-money decimals (package sizes such as 1.5 litres): stored as REAL. */
export const DECIMAL_COLUMNS: Record<string, string[]> = {
  'public.catalog_products': ['package_quantity'],
  'public.catalog_corrections': ['proposed_package_quantity'],
};

export function storeOf(table: string): Store {
  if (SHOP_TABLES.has(table)) return 'shop';
  if (D1_TABLES.has(table)) return 'd1';
  throw new Error(`Table ${table} is not assigned to D1 or the shop Durable Object (scripts/migrate-data/lib/partition.ts).`);
}

/** SQLite has no schemas. Postgres names are unique across public/private, so the bare name is kept. */
export function sqliteTableName(table: string): string {
  if (table === 'auth.users') return 'users';
  return table.slice(table.indexOf('.') + 1);
}

export function isMoney(table: string, column: string): boolean {
  return MONEY_COLUMNS[table]?.includes(column) ?? false;
}

export function sqliteColumnName(table: string, column: string): string {
  return isMoney(table, column) ? `${column}_cents` : column;
}
