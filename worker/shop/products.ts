/**
 * Products, packagings, extra barcodes, pictures and low-stock dismissals, ported from the
 * Postgres functions of the same names. Trigger rules that guarded these tables
 * (product_barcode_free_of_aliases, alias_barcode_free_of_products, copy_catalog_image,
 * keep_packaging_conversion) are enforced where each write happens.
 */
import { conflict, forbidden, invalid, notFound } from '../db/errors';
import { toApiRow, type ApiRow } from '../db/rows';
import { one, type SqlRow, type SyncSql } from '../db/sql';
import { assertPermission, assertShopRole, hasPermission, type ShopCall } from './context';
import {
  charLength,
  cleanBarcode,
  get,
  idArg,
  insert,
  intArg,
  optionalCents,
  optionalId,
  optionalText,
  productStock,
  timestampArg,
  trimmed,
  uuid,
} from './common';

type Args = Record<string, unknown>;

export const CATEGORIES = [
  'groceries',
  'beverages',
  'snacks',
  'bakery',
  'dairy',
  'personal_care',
  'household',
  'airtime',
  'other',
];

const product = (sql: SyncSql, id: string) => toApiRow('products', get(sql, 'products', id));

function priceArgs(a: Args): { buying: number | null; selling: number | null } {
  const buying = optionalCents(a.p_buying_price);
  const selling = optionalCents(a.p_selling_price);
  if ((buying !== null && buying < 0) || (selling !== null && selling < 0)) throw invalid('Prices cannot be negative.');
  return { buying, selling };
}

/** Trigger product_barcode_free_of_aliases. */
function assertNoActiveAlias(sql: SyncSql, shopId: string, barcode: string): void {
  if (one(sql, 'SELECT 1 AS x FROM product_barcodes WHERE shop_id = ? AND barcode = ? AND unlinked_at IS NULL', shopId, barcode)) {
    throw conflict(`Barcode ${barcode} is already linked to a product in this shop.`);
  }
}

/**
 * private.attach_catalog_link: links a product to a shared catalog product when the catalog
 * product exists (inputs.catalog), the product has no link yet, and no other active product in
 * the shop already has it.
 */
function attachCatalogLink(call: ShopCall, sql: SyncSql, row: SqlRow, catalogId: string | null): ApiRow {
  const id = String(row.id);
  if (catalogId === null || row.catalog_product_id !== null) return product(sql, id)!;
  if (!call.inputs.catalog?.[catalogId]) return product(sql, id)!;
  const taken = one(
    sql,
    'SELECT 1 AS x FROM products WHERE shop_id = ? AND catalog_product_id = ? AND archived_at IS NULL AND id <> ?',
    row.shop_id,
    catalogId,
    id
  );
  if (taken) return product(sql, id)!;
  try {
    sql.run(
      'UPDATE products SET catalog_product_id = ? WHERE id = ? AND shop_id = ? AND catalog_product_id IS NULL',
      catalogId,
      id,
      row.shop_id
    );
  } catch {
    // unique_violation: keep the product as it was.
  }
  return product(sql, id)!;
}

/** public.upsert_product: create a product, or return the one that already has this id or barcode. */
export function upsertProduct(call: ShopCall, sql: SyncSql, a: Args): ApiRow {
  const { ctx } = call;
  assertShopRole(ctx, ['owner', 'manager', 'staff']);
  const shopId = ctx.shopId;
  if (a.p_id === null || a.p_id === undefined) throw invalid('Product id is required.');
  const id = idArg(a.p_id, 'Product id is required.');
  const barcode = cleanBarcode(a.p_barcode);
  if (barcode === '' || charLength(barcode) > 64) throw invalid('Barcode is required (up to 64 characters).');
  if (trimmed(a.p_name) === '') throw invalid('Product name is required.');
  const { buying, selling } = priceArgs(a);
  const brand = optionalText(a.p_brand, null, 80, 'Brand');
  const size = optionalText(a.p_size, null, 40, 'Size');
  const catalogId = optionalId(a.p_catalog_product_id);

  const existing = one(sql, 'SELECT * FROM products WHERE id = ? AND shop_id = ?', id, shopId);
  if (existing) return attachCatalogLink(call, sql, existing, catalogId);

  const alias = one<{ product_id: string; packaging_id: string | null }>(
    sql,
    'SELECT product_id, packaging_id FROM product_barcodes WHERE shop_id = ? AND barcode = ? AND unlinked_at IS NULL',
    shopId,
    barcode
  );
  if (alias) {
    if (alias.packaging_id !== null) {
      throw conflict(`Barcode ${barcode} is linked to a pack of another product in this shop.`);
    }
    return attachCatalogLink(call, sql, get(sql, 'products', alias.product_id)!, catalogId);
  }

  const sameBarcode = one(sql, 'SELECT * FROM products WHERE shop_id = ? AND barcode = ?', shopId, barcode);
  if (sameBarcode) return attachCatalogLink(call, sql, sameBarcode, catalogId);
  // Product ids are unique across shops in Postgres; here each shop has its own database.
  insert(sql, 'products', {
    id,
    shop_id: shopId,
    barcode,
    name: trimmed(a.p_name),
    category: a.p_category == null ? 'other' : String(a.p_category),
    buying_price_cents: buying,
    selling_price_cents: selling,
    created_at: timestampArg(a.p_created_at, ctx.now),
    updated_at: ctx.now,
    brand,
    size,
  });
  return attachCatalogLink(call, sql, get(sql, 'products', id)!, catalogId);
}

/** public.update_product */
export function updateProduct({ ctx }: ShopCall, sql: SyncSql, a: Args): ApiRow {
  assertPermission(ctx, 'products.edit');
  const shopId = ctx.shopId;
  const barcode = cleanBarcode(a.p_barcode);
  const name = trimmed(a.p_name);
  if (a.p_product_id === null || a.p_product_id === undefined) throw invalid('Product id is required.');
  const id = idArg(a.p_product_id, 'Product id is required.');
  if (barcode === '' || charLength(barcode) > 64) throw invalid('Barcode is required (up to 64 characters).');
  if (name === '' || charLength(name) > 200) throw invalid('Product name is required (up to 200 characters).');
  if (typeof a.p_category !== 'string' || !CATEGORIES.includes(a.p_category)) throw invalid('Unknown product category.');
  const { buying, selling } = priceArgs(a);

  const current = one<{ brand: string | null; size: string | null }>(
    sql,
    'SELECT brand, size FROM products WHERE id = ? AND shop_id = ?',
    id,
    shopId
  );
  if (!current) throw notFound('Product not found in this shop.');
  const taken =
    one(sql, 'SELECT 1 AS x FROM products WHERE shop_id = ? AND barcode = ? AND id <> ?', shopId, barcode, id) ||
    one(sql, 'SELECT 1 AS x FROM product_barcodes WHERE shop_id = ? AND barcode = ? AND unlinked_at IS NULL', shopId, barcode);
  if (taken) throw conflict(`Another product in this shop already uses barcode ${barcode}.`);

  sql.run(
    `UPDATE products SET barcode = ?, name = ?, category = ?, buying_price_cents = ?, selling_price_cents = ?,
            brand = ?, size = ? WHERE id = ? AND shop_id = ?`,
    barcode,
    name,
    a.p_category,
    buying,
    selling,
    optionalText(a.p_brand, current.brand, 80, 'Brand'),
    optionalText(a.p_size, current.size, 40, 'Size'),
    id,
    shopId
  );
  return product(sql, id)!;
}

function requireProductId(a: Args, message = 'Product id is required.'): string {
  if (a.p_product_id === null || a.p_product_id === undefined) throw invalid(message);
  return idArg(a.p_product_id, message);
}

/** public.set_product_archived: archiving twice keeps the first archive time; open expiry alerts close. */
export function setProductArchived({ ctx }: ShopCall, sql: SyncSql, a: Args): ApiRow {
  assertPermission(ctx, 'products.edit');
  if (a.p_product_id == null || a.p_archived == null) throw invalid('Product id and archived flag are required.');
  const id = requireProductId(a);
  const row = one<{ archived_at: string | null }>(sql, 'SELECT archived_at FROM products WHERE id = ? AND shop_id = ?', id, ctx.shopId);
  if (!row) throw notFound('Product not found in this shop.');
  if (a.p_archived && row.archived_at === null) {
    sql.run('UPDATE products SET archived_at = ? WHERE id = ?', ctx.now, id);
    sql.run(
      `UPDATE expiry_alerts SET resolved_at = ?, resolution = 'product_archived'
        WHERE shop_id = ? AND product_id = ? AND resolved_at IS NULL`,
      ctx.now,
      ctx.shopId,
      id
    );
  } else if (!a.p_archived && row.archived_at !== null) {
    sql.run('UPDATE products SET archived_at = NULL WHERE id = ?', id);
  }
  return product(sql, id)!;
}

function updateOne(sql: SyncSql, ctx: ShopCall['ctx'], id: string, set: string, ...values: (string | number | null)[]): ApiRow {
  const changed = sql.run(`UPDATE products SET ${set} WHERE id = ? AND shop_id = ?`, ...values, id, ctx.shopId);
  if (changed === 0) throw notFound('Product not found in this shop.');
  return product(sql, id)!;
}

/** public.set_product_listed */
export function setProductListed({ ctx }: ShopCall, sql: SyncSql, a: Args): ApiRow {
  assertPermission(ctx, 'products.edit');
  if (a.p_product_id == null || a.p_listed == null) throw invalid('Product id and visibility are required.');
  return updateOne(sql, ctx, requireProductId(a), 'listed = ?', a.p_listed ? 1 : 0);
}

/** public.set_product_min_stock */
export function setProductMinStock({ ctx }: ShopCall, sql: SyncSql, a: Args): ApiRow {
  assertPermission(ctx, 'products.edit');
  const id = requireProductId(a);
  const min = intArg(a.p_min_stock);
  if (min !== null && min < 0) throw invalid('Minimum stock cannot be negative.');
  return updateOne(sql, ctx, id, 'min_stock_units = ?', min);
}

/** public.set_product_target_stock */
export function setProductTargetStock({ ctx }: ShopCall, sql: SyncSql, a: Args): ApiRow {
  assertPermission(ctx, 'products.edit');
  const id = requireProductId(a);
  const target = intArg(a.p_target);
  if (target !== null && target < 0) throw invalid('Target stock cannot be negative.');
  const current = one<{ min_stock_units: number | null }>(sql, 'SELECT min_stock_units FROM products WHERE id = ? AND shop_id = ?', id, ctx.shopId);
  if (!current) throw notFound('Product not found in this shop.');
  if (current.min_stock_units !== null && target !== null && target < current.min_stock_units) {
    throw invalid('Target stock must be at least the minimum.');
  }
  return updateOne(sql, ctx, id, 'target_stock_units = ?', target);
}

const SHOP_IMAGE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/[0-9a-f]{32}\.(webp|jpg)$/;

/** private.product_image_shop */
export function productImageShop(path: string): string | null {
  return SHOP_IMAGE.exec(path)?.[1] ?? null;
}

/**
 * public.set_product_image. Reads inputs.imagesPresent (R2) for the new path. previous_path is
 * the old picture when nothing in the shop uses it any more, so the Worker can delete it.
 */
export function setProductImage(call: ShopCall, sql: SyncSql, a: Args): ApiRow {
  const { ctx } = call;
  assertShopRole(ctx, ['owner', 'manager', 'staff']);
  const path = trimmed(a.p_image_path) || null;
  const id = requireProductId(a);
  if (path !== null && productImageShop(path) !== ctx.shopId) throw invalid('This picture does not belong to this shop.');
  const row = one<{ image_path: string | null }>(sql, 'SELECT image_path FROM products WHERE id = ? AND shop_id = ?', id, ctx.shopId);
  if (!row) throw notFound('Product not found in this shop.');
  const previous = row.image_path;
  if (previous === path) return { product: product(sql, id), previous_path: null };
  if (!hasPermission(ctx, 'products.edit') && !(previous === null && path !== null)) {
    throw forbidden('Only an owner or manager can change a product picture.');
  }
  if (path !== null && !call.inputs.imagesPresent?.includes(path)) throw invalid('The picture has not been uploaded.');
  sql.run('UPDATE products SET image_path = ? WHERE id = ?', path, id);
  const stillUsed = previous !== null && one(sql, 'SELECT 1 AS x FROM products WHERE image_path = ?', previous);
  return {
    product: product(sql, id),
    // Catalog pictures (catalog/…) are shared and never deleted from here.
    previous_path: previous === null || previous.startsWith('catalog/') || stillUsed ? null : previous,
  };
}

function packagingName(a: Args): string {
  const name = trimmed(a.p_name);
  if (name === '' || charLength(name) > 40) throw invalid('Packaging name is required (up to 40 characters).');
  return name;
}

function packPrice(value: unknown): number | null {
  const cents = optionalCents(value);
  if (cents !== null && (cents < 0 || cents > 999_999_999_999)) throw invalid('Pack price cannot be negative.');
  return cents;
}

const packaging = (sql: SyncSql, id: string) => toApiRow('product_packagings', get(sql, 'product_packagings', id));

/** public.create_product_packaging */
export function createProductPackaging({ ctx }: ShopCall, sql: SyncSql, a: Args): ApiRow {
  assertPermission(ctx, 'products.edit');
  if (a.p_id == null) throw invalid('Packaging id is required.');
  const id = idArg(a.p_id, 'Packaging id is required.');
  const name = packagingName(a);
  const units = intArg(a.p_units_per_package);
  if (units === null || units < 2 || units > 10_000) throw invalid('A packaging holds 2 to 10,000 units.');
  const price = packPrice(a.p_selling_price);
  const productId = optionalId(a.p_product_id);
  if (!productId || !one(sql, 'SELECT 1 AS x FROM products WHERE id = ? AND shop_id = ?', productId, ctx.shopId)) {
    throw notFound('Product not found in this shop.');
  }
  const existing = get(sql, 'product_packagings', id);
  if (existing) {
    if (existing.shop_id === ctx.shopId && existing.product_id === productId && existing.name === name && existing.units_per_package === units) {
      if (price !== null && existing.selling_price_cents !== price) {
        sql.run('UPDATE product_packagings SET selling_price_cents = ?, updated_at = ? WHERE id = ?', price, ctx.now, id);
      }
      return packaging(sql, id)!;
    }
    throw conflict('This packaging id is already used elsewhere.');
  }
  insert(sql, 'product_packagings', {
    id,
    shop_id: ctx.shopId,
    product_id: productId,
    name,
    units_per_package: units,
    selling_price_cents: price,
    created_by: ctx.userId,
    created_at: timestampArg(a.p_created_at, ctx.now),
    updated_at: ctx.now,
  });
  return packaging(sql, id)!;
}

/** public.retire_product_packaging: unlinks its barcodes too. */
export function retireProductPackaging({ ctx }: ShopCall, sql: SyncSql, a: Args): ApiRow {
  assertPermission(ctx, 'products.edit');
  const id = optionalId(a.p_packaging_id);
  const row = id ? one<{ retired_at: string | null }>(sql, 'SELECT retired_at FROM product_packagings WHERE id = ? AND shop_id = ?', id, ctx.shopId) : null;
  if (!row) throw notFound('Packaging not found in this shop.');
  if (row.retired_at !== null) return packaging(sql, id!)!;
  sql.run(
    `UPDATE product_barcodes SET unlinked_at = ?, unlinked_by = ?, unlink_reason = 'Packaging retired'
      WHERE packaging_id = ? AND shop_id = ? AND unlinked_at IS NULL`,
    ctx.now,
    ctx.userId,
    id!,
    ctx.shopId
  );
  sql.run('UPDATE product_packagings SET retired_at = ? WHERE id = ?', ctx.now, id!);
  return packaging(sql, id!)!;
}

/** public.set_packaging_price */
export function setPackagingPrice({ ctx }: ShopCall, sql: SyncSql, a: Args): ApiRow {
  assertPermission(ctx, 'products.edit');
  const price = packPrice(a.p_selling_price);
  const id = optionalId(a.p_packaging_id);
  const changed = id
    ? sql.run('UPDATE product_packagings SET selling_price_cents = ?, updated_at = ? WHERE id = ? AND shop_id = ?', price, ctx.now, id, ctx.shopId)
    : 0;
  if (changed === 0) throw notFound('Packaging not found in this shop.');
  return packaging(sql, id!)!;
}

const barcodeLink = (sql: SyncSql, id: string) => toApiRow('product_barcodes', get(sql, 'product_barcodes', id));

/** public.link_product_barcode: an extra barcode for a product, or for one of its packs. */
export function linkProductBarcode({ ctx }: ShopCall, sql: SyncSql, a: Args): ApiRow {
  assertPermission(ctx, 'products.edit');
  const barcode = cleanBarcode(a.p_barcode);
  if (a.p_id == null) throw invalid('Barcode link id is required.');
  const id = idArg(a.p_id, 'Barcode link id is required.');
  if (barcode === '' || charLength(barcode) > 64) throw invalid('Barcode is required (up to 64 characters).');
  const productId = optionalId(a.p_product_id);
  if (!productId || !one(sql, 'SELECT 1 AS x FROM products WHERE id = ? AND shop_id = ?', productId, ctx.shopId)) {
    throw notFound('Product not found in this shop.');
  }
  const packagingId = optionalId(a.p_packaging_id);
  const existing = get(sql, 'product_barcodes', id);
  if (existing) {
    if (existing.shop_id === ctx.shopId && existing.product_id === productId && existing.barcode === barcode && existing.packaging_id === packagingId) {
      return barcodeLink(sql, id)!;
    }
    throw conflict('This barcode link id is already used elsewhere.');
  }
  if (packagingId !== null) {
    const pack = one<{ retired_at: string | null }>(
      sql,
      'SELECT retired_at FROM product_packagings WHERE id = ? AND shop_id = ? AND product_id = ?',
      packagingId,
      ctx.shopId,
      productId
    );
    if (!pack) throw notFound('Packaging not found for this product.');
    if (pack.retired_at !== null) throw invalid('This packaging has been retired. Choose another one.');
  }
  const owner = one<{ name: string }>(sql, 'SELECT name FROM products WHERE shop_id = ? AND barcode = ?', ctx.shopId, barcode);
  if (owner) throw conflict(`Barcode ${barcode} is already used by ${owner.name}.`);
  const active = one<{ product_id: string; packaging_id: string | null }>(
    sql,
    'SELECT product_id, packaging_id FROM product_barcodes WHERE shop_id = ? AND barcode = ? AND unlinked_at IS NULL',
    ctx.shopId,
    barcode
  );
  if (active) {
    // The same link made on another phone: keep the first one.
    if (active.product_id === productId && active.packaging_id === packagingId) {
      const first = one<{ id: string }>(sql, 'SELECT id FROM product_barcodes WHERE shop_id = ? AND barcode = ? AND unlinked_at IS NULL', ctx.shopId, barcode)!;
      return barcodeLink(sql, first.id)!;
    }
    const other = one<{ name: string }>(sql, 'SELECT name FROM products WHERE id = ?', active.product_id);
    throw conflict(`Barcode ${barcode} is already used by ${other?.name ?? ''}.`);
  }
  insert(sql, 'product_barcodes', {
    id,
    shop_id: ctx.shopId,
    product_id: productId,
    packaging_id: packagingId,
    barcode,
    created_by: ctx.userId,
    created_at: timestampArg(a.p_created_at, ctx.now),
    updated_at: ctx.now,
  });
  return barcodeLink(sql, id)!;
}

/** public.unlink_product_barcode: optionally takes back untouched stock received under it. */
export function unlinkProductBarcode({ ctx }: ShopCall, sql: SyncSql, a: Args): ApiRow {
  assertPermission(ctx, 'products.edit');
  const reverse = Boolean(a.p_reverse_unsold);
  if (reverse && !hasPermission(ctx, 'stock.adjust')) throw forbidden('You cannot take stock back out in this shop.');
  const reason = trimmed(a.p_reason);
  if (reason === '' || charLength(reason) > 200) throw invalid('A reason is required (up to 200 characters).');
  const id = optionalId(a.p_barcode_id);
  const link = id ? one<{ product_id: string; unlinked_at: string | null }>(sql, 'SELECT product_id, unlinked_at FROM product_barcodes WHERE id = ? AND shop_id = ?', id, ctx.shopId) : null;
  if (!link) throw notFound('Barcode link not found in this shop.');
  if (link.unlinked_at !== null) {
    return { barcode: barcodeLink(sql, id!), duplicate: true, reversed: [], kept: [] };
  }
  sql.run('UPDATE product_barcodes SET unlinked_at = ?, unlinked_by = ?, unlink_reason = ? WHERE id = ?', ctx.now, ctx.userId, reason, id!);
  const reversed: ApiRow[] = [];
  const kept: ApiRow[] = [];
  const batches = sql.all<{ id: string; product_id: string; quantity: number; initial_quantity: number }>(
    'SELECT id, product_id, quantity, initial_quantity FROM stock_batches WHERE shop_id = ? AND received_barcode_id = ? AND quantity > 0 ORDER BY received_at, id',
    ctx.shopId,
    id!
  );
  for (const batch of batches) {
    if (reverse && batch.quantity === batch.initial_quantity) {
      sql.run('UPDATE stock_batches SET quantity = 0 WHERE id = ?', batch.id);
      insert(sql, 'stock_movements', {
        id: uuid(),
        shop_id: ctx.shopId,
        product_id: batch.product_id,
        batch_id: batch.id,
        reason: 'count_correction',
        quantity_delta: -batch.quantity,
        resulting_total_quantity: productStock(sql, ctx.shopId, batch.product_id),
        idempotency_key: `unlink:${id}:${batch.id}`,
        actor_id: ctx.userId,
        occurred_at: timestampArg(a.p_occurred_at, ctx.now),
        created_at: ctx.now,
        updated_at: ctx.now,
      });
      reversed.push({ batch_id: batch.id, quantity: batch.quantity });
    } else {
      kept.push({ batch_id: batch.id, quantity: batch.quantity, initial_quantity: batch.initial_quantity });
    }
  }
  return {
    barcode: barcodeLink(sql, id!),
    duplicate: false,
    reversed,
    kept,
    total_quantity: productStock(sql, ctx.shopId, link.product_id),
  };
}

const dismissal = (sql: SyncSql, shopId: string, productId: string) =>
  toApiRow('low_stock_dismissals', one(sql, 'SELECT * FROM low_stock_dismissals WHERE shop_id = ? AND product_id = ?', shopId, productId));

/** public.dismiss_low_stock: hide a low-stock warning until stock recovers. */
export function dismissLowStock({ ctx }: ShopCall, sql: SyncSql, a: Args): ApiRow | null {
  assertPermission(ctx, 'inventory.view');
  const productId = requireProductId(a);
  if (!one(sql, 'SELECT 1 AS x FROM products WHERE id = ? AND shop_id = ?', productId, ctx.shopId)) {
    throw notFound('Product not found in this shop.');
  }
  const current = one<{ cleared_at: string | null }>(sql, 'SELECT cleared_at FROM low_stock_dismissals WHERE shop_id = ? AND product_id = ?', ctx.shopId, productId);
  if (!current) {
    insert(sql, 'low_stock_dismissals', {
      id: uuid(),
      shop_id: ctx.shopId,
      product_id: productId,
      dismissed_at: ctx.now,
      dismissed_by: ctx.userId,
      updated_at: ctx.now,
    });
  } else if (current.cleared_at !== null) {
    sql.run(
      'UPDATE low_stock_dismissals SET dismissed_at = ?, dismissed_by = ?, cleared_at = NULL WHERE shop_id = ? AND product_id = ?',
      ctx.now,
      ctx.userId,
      ctx.shopId,
      productId
    );
  }
  return dismissal(sql, ctx.shopId, productId);
}

/** public.clear_low_stock_dismissal */
export function clearLowStockDismissal({ ctx }: ShopCall, sql: SyncSql, a: Args): ApiRow | null {
  assertPermission(ctx, 'inventory.view');
  const productId = requireProductId(a);
  sql.run(
    'UPDATE low_stock_dismissals SET cleared_at = ? WHERE shop_id = ? AND product_id = ? AND cleared_at IS NULL',
    ctx.now,
    ctx.shopId,
    productId
  );
  return dismissal(sql, ctx.shopId, productId);
}
