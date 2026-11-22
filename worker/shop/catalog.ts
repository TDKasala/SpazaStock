/**
 * The shop side of the shared catalog: adopting a catalog product into the shop with its
 * barcodes and packs (public.adopt_catalog_product + private.copy_catalog_barcodes), and the
 * per-shop state catalog search needs. Catalog rows come from D1 through ShopCall.inputs.
 */
import { conflict, forbidden as forbiddenShop, invalid, notFound, suspended as suspendedShop } from '../db/errors';
import { toApiRow, toApiRows, type ApiRow } from '../db/rows';
import { one, type SyncSql } from '../db/sql';
import { assertShopRole, localDate, type ShopCall } from './context';
import { recordStockIn } from './stock';
import { get, idArg, insert, optionalCents, timestampArg, uuid } from './common';

type Args = Record<string, unknown>;

export interface CatalogProductInput {
  id: string;
  name: string;
  brand: string | null;
  category: string;
  package_size: string | null;
  image_path: string | null;
}

export interface CatalogBarcodeInput {
  barcode: string;
  kind: 'unit' | 'alternate' | 'pack';
  units_per_package: number | null;
  created_at: string;
}

/** private.copy_catalog_barcodes: the catalog's extra barcodes and packs, added to the shop product. */
export function copyCatalogBarcodes(
  call: ShopCall,
  sql: SyncSql,
  productId: string,
  barcodes: CatalogBarcodeInput[]
): { packagings: ApiRow[]; barcodes: ApiRow[] } {
  const { ctx } = call;
  const shopId = ctx.shopId;
  const productBarcode = one<{ barcode: string }>(sql, 'SELECT barcode FROM products WHERE id = ? AND shop_id = ?', productId, shopId)?.barcode;
  const sorted = [...barcodes].sort((a, b) => (a.kind === b.kind ? (a.barcode < b.barcode ? -1 : 1) : a.kind < b.kind ? -1 : 1));
  const taken = (code: string) => conflict(`Barcode ${code} is already used in this shop.`);

  for (const code of sorted) {
    if (code.kind === 'unit' || code.kind === 'alternate') {
      if (code.barcode === productBarcode) continue;
      if (one(sql, 'SELECT 1 AS x FROM products WHERE shop_id = ? AND barcode = ? AND id <> ?', shopId, code.barcode, productId)) throw taken(code.barcode);
      const link = one<{ product_id: string; packaging_id: string | null }>(
        sql,
        'SELECT product_id, packaging_id FROM product_barcodes WHERE shop_id = ? AND barcode = ? AND unlinked_at IS NULL',
        shopId,
        code.barcode
      );
      if (link) {
        if (link.product_id !== productId || link.packaging_id !== null) throw taken(code.barcode);
      } else {
        insert(sql, 'product_barcodes', {
          id: uuid(),
          shop_id: shopId,
          product_id: productId,
          packaging_id: null,
          barcode: code.barcode,
          created_by: ctx.userId,
          created_at: ctx.now,
          updated_at: ctx.now,
        });
      }
    } else if (code.kind === 'pack') {
      let packagingId =
        one<{ id: string }>(
          sql,
          `SELECT id FROM product_packagings WHERE shop_id = ? AND product_id = ? AND units_per_package = ? AND retired_at IS NULL
            ORDER BY created_at LIMIT 1`,
          shopId,
          productId,
          code.units_per_package
        )?.id ?? null;
      if (!packagingId) {
        packagingId = uuid();
        insert(sql, 'product_packagings', {
          id: packagingId,
          shop_id: shopId,
          product_id: productId,
          name: `Pack of ${code.units_per_package}`,
          units_per_package: code.units_per_package,
          created_by: ctx.userId,
          created_at: ctx.now,
          updated_at: ctx.now,
        });
      }
      if (one(sql, 'SELECT 1 AS x FROM products WHERE shop_id = ? AND barcode = ?', shopId, code.barcode)) throw taken(code.barcode);
      const link = one<{ product_id: string; packaging_id: string | null }>(
        sql,
        'SELECT product_id, packaging_id FROM product_barcodes WHERE shop_id = ? AND barcode = ? AND unlinked_at IS NULL',
        shopId,
        code.barcode
      );
      if (link) {
        if (link.product_id !== productId || link.packaging_id !== packagingId) throw taken(code.barcode);
      } else {
        insert(sql, 'product_barcodes', {
          id: uuid(),
          shop_id: shopId,
          product_id: productId,
          packaging_id: packagingId,
          barcode: code.barcode,
          created_by: ctx.userId,
          created_at: ctx.now,
          updated_at: ctx.now,
        });
      }
    }
  }

  const packSizes = new Set(barcodes.filter((b) => b.kind === 'pack').map((b) => b.units_per_package));
  const codes = new Set(barcodes.map((b) => b.barcode));
  return {
    packagings: toApiRows(
      'product_packagings',
      sql
        .all('SELECT * FROM product_packagings WHERE shop_id = ? AND product_id = ? AND retired_at IS NULL ORDER BY created_at, rowid', shopId, productId)
        .filter((g) => packSizes.has(Number(g.units_per_package)))
    ),
    barcodes: toApiRows(
      'product_barcodes',
      sql
        .all('SELECT * FROM product_barcodes WHERE shop_id = ? AND product_id = ? AND unlinked_at IS NULL ORDER BY created_at, rowid', shopId, productId)
        .filter((b) => codes.has(String(b.barcode)))
    ),
  };
}

/**
 * public.adopt_catalog_product. inputs.catalogProduct / inputs.catalogBarcodes: the catalog row
 * and its barcodes from D1 (absent when the catalog product does not exist).
 */
export function adoptCatalogProduct(call: ShopCall, sql: SyncSql, a: Args): ApiRow {
  const { ctx } = call;
  assertShopRole(ctx, ['owner', 'manager', 'staff']);
  if (a.p_id == null) throw invalid('Product id is required.');
  const id = idArg(a.p_id, 'Product id is required.');
  if (a.p_catalog_product_id == null) throw invalid('Catalog product id is required.');
  const buying = optionalCents(a.p_buying_price);
  const selling = optionalCents(a.p_selling_price);
  if ((buying !== null && buying < 0) || (selling !== null && selling < 0)) throw invalid('Prices cannot be negative.');
  const catalog = call.inputs.catalogProduct as CatalogProductInput | undefined;
  if (!catalog) throw notFound('Catalog product not found.');
  const barcodes = (call.inputs.catalogBarcodes as CatalogBarcodeInput[] | undefined) ?? [];
  const primary = [...barcodes]
    .filter((b) => b.kind === 'unit' || b.kind === 'alternate')
    .sort(
      (x, y) =>
        (x.kind === 'unit' ? 0 : 1) - (y.kind === 'unit' ? 0 : 1) ||
        (x.created_at < y.created_at ? -1 : x.created_at > y.created_at ? 1 : 0) ||
        (x.barcode < y.barcode ? -1 : 1)
    )[0]?.barcode;
  if (!primary) throw invalid('This catalog product has no single-item barcode.');

  let product =
    one(sql, 'SELECT * FROM products WHERE shop_id = ? AND catalog_product_id = ? AND archived_at IS NULL', ctx.shopId, catalog.id) ??
    one(sql, 'SELECT * FROM products WHERE shop_id = ? AND barcode = ?', ctx.shopId, primary);
  let created = false;
  let links: { packagings: ApiRow[]; barcodes: ApiRow[] };
  if (!product) {
    if (one(sql, 'SELECT 1 AS x FROM product_barcodes WHERE shop_id = ? AND barcode = ? AND unlinked_at IS NULL', ctx.shopId, primary)) {
      throw conflict(`Barcode ${primary} is already linked to a product in this shop.`);
    }
    insert(sql, 'products', {
      id,
      shop_id: ctx.shopId,
      barcode: primary,
      name: catalog.name,
      category: catalog.category,
      buying_price_cents: buying,
      selling_price_cents: selling,
      created_at: timestampArg(a.p_created_at, ctx.now),
      updated_at: ctx.now,
      brand: catalog.brand,
      size: catalog.package_size,
      catalog_product_id: catalog.id,
      // private.copy_catalog_image (insert trigger): start with the catalog's picture.
      image_path: catalog.image_path,
    });
    product = get(sql, 'products', id)!;
    created = true;
    links = copyCatalogBarcodes(call, sql, id, barcodes);
  } else if (product.archived_at !== null) {
    links = { packagings: [], barcodes: [] };
  } else {
    if (product.catalog_product_id !== null && product.catalog_product_id !== catalog.id) {
      throw conflict(`Barcode ${primary} is already used in this shop.`);
    }
    if (product.catalog_product_id === null) {
      const other = one(
        sql,
        'SELECT 1 AS x FROM products WHERE shop_id = ? AND catalog_product_id = ? AND archived_at IS NULL AND id <> ?',
        ctx.shopId,
        catalog.id,
        product.id
      );
      if (!other) sql.run('UPDATE products SET catalog_product_id = ? WHERE id = ? AND catalog_product_id IS NULL', catalog.id, product.id);
      product = get(sql, 'products', String(product.id))!;
    }
    if (product.catalog_product_id !== catalog.id) throw conflict(`Barcode ${primary} is already used in this shop.`);
    links = copyCatalogBarcodes(call, sql, String(product.id), barcodes);
  }
  return { created, product: toApiRow('products', get(sql, 'products', String(product.id))), packagings: links.packagings, barcodes: links.barcodes };
}

export interface CatalogLinkState {
  product_id: string;
  catalog_product_id: string;
  listed: boolean;
  min_stock_units: number | null;
  sellable: number;
  expiring: boolean;
}

/**
 * For catalog search: each active shop product linked to a catalog product, with
 * private.shop_product_stock_state (sellable units today, anything expiring within 7 days).
 */
export function catalogLinks(sql: SyncSql, shopId: string, today: string): CatalogLinkState[] {
  const week = new Date(Date.parse(`${today}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
  return sql
    .all<{ id: string; catalog_product_id: string; listed: number; min_stock_units: number | null; sellable: number; expiring: number }>(
      `SELECT p.id, p.catalog_product_id, p.listed, p.min_stock_units,
              coalesce((SELECT sum(b.quantity) FROM stock_batches b WHERE b.shop_id = p.shop_id AND b.product_id = p.id
                         AND b.quantity > 0 AND (b.expiry_date IS NULL OR b.expiry_date >= ?)), 0) AS sellable,
              EXISTS (SELECT 1 FROM stock_batches b WHERE b.shop_id = p.shop_id AND b.product_id = p.id
                         AND b.quantity > 0 AND b.expiry_date IS NOT NULL AND b.expiry_date <= ?) AS expiring
         FROM products p
        WHERE p.shop_id = ? AND p.catalog_product_id IS NOT NULL AND p.archived_at IS NULL
        ORDER BY p.rowid`,
      today,
      week,
      shopId
    )
    .map((r) => ({
      product_id: r.id,
      catalog_product_id: r.catalog_product_id,
      listed: r.listed === 1,
      min_stock_units: r.min_stock_units,
      sellable: Number(r.sellable),
      expiring: Number(r.expiring) === 1,
    }));
}

export interface CatalogEntryInput {
  product: CatalogProductInput & { common: boolean };
  barcodes: CatalogBarcodeInput[];
}

interface CatalogChoice {
  catalogId: string;
  buying: number | null;
  selling: number | null;
  /** review_shop_catalog: sell (listed) or hide; confirm_shop_catalog leaves listing alone. */
  listed: boolean | null;
}

/** Shared body of confirm_shop_catalog and review_shop_catalog: add or update each chosen product. */
function applyCatalogChoices(call: ShopCall, sql: SyncSql, choices: CatalogChoice[], notCommon: string): ApiRow[] {
  const { ctx } = call;
  const entries = (call.inputs.catalogEntries as Record<string, CatalogEntryInput> | undefined) ?? {};
  const results: ApiRow[] = [];
  const setListed = (id: string, listed: boolean | null) => {
    if (listed === null) return;
    sql.run('UPDATE products SET listed = ? WHERE id = ? AND shop_id = ? AND listed IS NOT ?', listed ? 1 : 0, id, ctx.shopId, listed ? 1 : 0);
  };
  for (const choice of choices) {
    const entry = entries[choice.catalogId];
    if (!entry) throw notFound('Catalog product not found.');
    if (!entry.product.common) throw invalid(notCommon);
    let product = one(sql, 'SELECT * FROM products WHERE shop_id = ? AND catalog_product_id = ? AND archived_at IS NULL', ctx.shopId, choice.catalogId);
    let created = false;
    let links: { packagings: ApiRow[]; barcodes: ApiRow[] } = { packagings: [], barcodes: [] };
    if (product) {
      setListed(String(product.id), choice.listed);
      product = get(sql, 'products', String(product.id));
    } else {
      const primary = primaryBarcode(entry.barcodes);
      if (!primary) throw invalid('This catalog product has no single-item barcode.');
      const byBarcode = one(sql, 'SELECT * FROM products WHERE shop_id = ? AND barcode = ?', ctx.shopId, primary);
      if (byBarcode && byBarcode.archived_at === null && byBarcode.catalog_product_id === null) {
        const other = one(sql, 'SELECT 1 AS x FROM products WHERE shop_id = ? AND catalog_product_id = ? AND archived_at IS NULL AND id <> ?', ctx.shopId, choice.catalogId, byBarcode.id);
        if (!other) sql.run('UPDATE products SET catalog_product_id = ? WHERE id = ? AND catalog_product_id IS NULL', choice.catalogId, byBarcode.id);
        setListed(String(byBarcode.id), choice.listed);
        product = get(sql, 'products', String(byBarcode.id));
      } else if (byBarcode) {
        if (byBarcode.archived_at === null) throw conflict(`Barcode ${primary} is already used in this shop.`);
        product = byBarcode;
      } else {
        if (one(sql, 'SELECT 1 AS x FROM product_barcodes WHERE shop_id = ? AND barcode = ? AND unlinked_at IS NULL', ctx.shopId, primary)) {
          throw conflict(`Barcode ${primary} is already linked to a product in this shop.`);
        }
        const id = uuid();
        insert(sql, 'products', {
          id,
          shop_id: ctx.shopId,
          barcode: primary,
          name: entry.product.name,
          category: entry.product.category,
          buying_price_cents: choice.buying,
          selling_price_cents: choice.selling,
          created_at: ctx.now,
          updated_at: ctx.now,
          brand: entry.product.brand,
          size: entry.product.package_size,
          catalog_product_id: choice.catalogId,
          image_path: entry.product.image_path,
          ...(choice.listed === null ? {} : { listed: choice.listed ? 1 : 0 }),
        });
        product = get(sql, 'products', id);
        created = true;
        links = copyCatalogBarcodes(call, sql, id, entry.barcodes);
      }
    }
    results.push({ created, product: toApiRow('products', product), packagings: links.packagings, barcodes: links.barcodes });
  }
  return results;
}

function catalogIdOf(raw: Record<string, unknown> | null | undefined): string {
  const idText = raw?.catalog_product_id == null || raw.catalog_product_id === '' ? null : String(raw.catalog_product_id);
  if (idText === null || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idText)) {
    throw invalid('Catalog product id is required.');
  }
  return idText.toLowerCase();
}

function choicePrices(raw: Record<string, unknown>): { buying: number | null; selling: number | null } {
  const buying = raw.buying_price == null || raw.buying_price === '' ? null : optionalCents(raw.buying_price);
  const selling = raw.selling_price == null || raw.selling_price === '' ? null : optionalCents(raw.selling_price);
  if ((buying !== null && buying < 0) || (selling !== null && selling < 0)) throw invalid('Prices cannot be negative.');
  return { buying, selling };
}

function assertEditor(ctx: ShopCall['ctx']): void {
  if (!ctx.permissions.includes('products.edit') || ctx.userId === null) throw forbiddenShop();
  if (!ctx.shopActive) throw suspendedShop();
}

/**
 * public.confirm_shop_catalog: adds the chosen common catalog products while a shop is set up.
 * inputs.catalogEntries: each selected catalog product (with common flag) and its barcodes.
 */
export function confirmShopCatalog(call: ShopCall, sql: SyncSql, a: Args): ApiRow {
  assertEditor(call.ctx);
  if (!Array.isArray(a.p_selections)) throw invalid('Choose catalogue products as a list.');
  const choices: CatalogChoice[] = [];
  const seen = new Set<string>();
  // Postgres validated and applied each selection in turn; an error leaves nothing behind either way.
  const results: ApiRow[] = [];
  for (const raw of a.p_selections as Record<string, unknown>[]) {
    const catalogId = catalogIdOf(raw);
    if (seen.has(catalogId)) continue;
    seen.add(catalogId);
    const choice = { catalogId, ...choicePrices(raw), listed: null };
    choices.push(choice);
    results.push(...applyCatalogChoices(call, sql, [choice], 'Only a common catalogue product can be added while setting up a shop.'));
  }
  call.effects.push({ kind: 'clear_catalog_prompt' });
  return { ok: true, products: results };
}

/** public.review_shop_catalog: sell or hide each common catalogue product (up to 50 at a time). */
export function reviewShopCatalog(call: ShopCall, sql: SyncSql, a: Args): ApiRow {
  assertEditor(call.ctx);
  const decisions = a.p_decisions;
  if (!Array.isArray(decisions) || decisions.length === 0) throw invalid('Choose at least one catalogue product.');
  if (decisions.length > 50) throw invalid('Review up to 50 products at a time.');
  const seen = new Set<string>();
  const results: ApiRow[] = [];
  for (const raw of decisions as Record<string, unknown>[]) {
    const catalogId = catalogIdOf(raw);
    if (seen.has(catalogId)) continue;
    seen.add(catalogId);
    if (raw.decision !== 'sell' && raw.decision !== 'hide') throw invalid('Choose sell or hide.');
    const listed = raw.decision === 'sell';
    const prices = listed ? choicePrices(raw) : { buying: null, selling: null };
    results.push(...applyCatalogChoices(call, sql, [{ catalogId, ...prices, listed }], 'Only a common catalogue product can be reviewed for this shop.'));
  }
  return { ok: true, products: results };
}

/** The single-item barcode a catalog product is sold under: unit first, then oldest alternate. */
export function primaryBarcode(barcodes: CatalogBarcodeInput[]): string | undefined {
  return [...barcodes]
    .filter((b) => b.kind === 'unit' || b.kind === 'alternate')
    .sort(
      (x, y) =>
        (x.kind === 'unit' ? 0 : 1) - (y.kind === 'unit' ? 0 : 1) ||
        (x.created_at < y.created_at ? -1 : x.created_at > y.created_at ? 1 : 0) ||
        (x.barcode < y.barcode ? -1 : 1)
    )[0]?.barcode;
}

/**
 * public.confirm_catalog_intake: the stock-taking wizard. Adopts each catalog product and records
 * its counted batches in one go. inputs.catalogEntries holds the catalog rows by id.
 */
export function confirmCatalogIntake(call: ShopCall, sql: SyncSql, a: Args): ApiRow {
  const { ctx } = call;
  assertShopRole(ctx, ['owner', 'manager', 'staff']);
  const items = a.p_items;
  if (!Array.isArray(items) || items.length < 1 || items.length > 40) throw invalid('Choose between 1 and 40 products.');
  const today = localDate(ctx.now, ctx.timezone);
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const asUuid = (v: unknown, message: string) => {
    if (v == null) return null;
    if (typeof v !== 'string' || !uuidRe.test(v)) throw invalid(message);
    return v.toLowerCase();
  };
  const seen = new Set<string>();
  const productKeys = new Set<string>();
  const batchIds = new Set<string>();
  for (const raw of items as Record<string, unknown>[]) {
    const item = raw ?? {};
    const catalogId = asUuid(item.catalog_product_id, 'Each product needs a catalogue id and a product id.');
    const productKey = asUuid(item.product_id, 'Each product needs a catalogue id and a product id.');
    if (!catalogId || !productKey) throw invalid('Each product needs a catalogue id and a product id.');
    if (seen.has(catalogId) || productKeys.has(productKey)) throw invalid('The same product was sent twice.');
    seen.add(catalogId);
    productKeys.add(productKey);
    for (const key of ['buying_price', 'selling_price']) {
      if (item[key] !== undefined && item[key] !== null) {
        const cents = optionalCents(item[key]);
        if (cents !== null && cents < 0) throw invalid('Prices cannot be negative.');
      }
    }
    const batches = item.batches;
    if (!Array.isArray(batches) || batches.length < 1 || batches.length > 8) throw invalid('Each product needs between 1 and 8 batches.');
    for (const b of batches as Record<string, unknown>[]) {
      const id = asUuid(b?.id, 'Each batch needs an id.');
      if (!id || batchIds.has(id)) throw invalid('Each batch needs its own id.');
      batchIds.add(id);
      const q = b.quantity == null ? '' : typeof b.quantity === 'string' ? b.quantity : JSON.stringify(b.quantity);
      if (!/^[0-9]+$/.test(q) || Number(q) < 1 || Number(q) > 1_000_000) throw invalid('Quantity must be a whole number from 1 to 1,000,000.');
      const expiry = b.expiry_date == null || b.expiry_date === '' ? null : String(b.expiry_date);
      if (expiry !== null) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry) || Number.isNaN(Date.parse(`${expiry}T00:00:00Z`))) throw invalid('Expiry date must be a calendar date.');
        if (expiry < today) throw invalid('Expiry date is already past.');
      }
    }
  }

  const entries = (call.inputs.catalogEntries as Record<string, CatalogEntryInput> | undefined) ?? {};
  const results: ApiRow[] = [];
  for (const raw of items as Record<string, unknown>[]) {
    const catalogId = String(raw.catalog_product_id).toLowerCase();
    const productKey = String(raw.product_id).toLowerCase();
    const buying = raw.buying_price == null ? null : optionalCents(raw.buying_price);
    const selling = raw.selling_price == null ? null : optionalCents(raw.selling_price);
    const entry = entries[catalogId];
    const adopt = adoptCatalogProduct(
      { ...call, inputs: entry ? { catalogProduct: entry.product, catalogBarcodes: entry.barcodes } : {} },
      sql,
      {
        p_id: productKey,
        p_shop_id: ctx.shopId,
        p_catalog_product_id: catalogId,
        p_buying_price: buying === null ? null : buying / 100,
        p_selling_price: selling === null ? null : selling / 100,
        p_created_at: ctx.now,
      }
    );
    const product = adopt.product as ApiRow;
    if (product.archived_at) throw invalid('This product is archived in this shop.');
    const productId = String(product.id);
    const requested = (raw.batches as Record<string, unknown>[]).map((b) => String(b.id).toLowerCase());
    const existing = sql.all<{ id: string }>('SELECT id FROM stock_batches WHERE shop_id = ? AND product_id = ?', ctx.shopId, productId).map((r) => r.id);
    const known = existing.some((id) => requested.includes(id));
    const other = existing.some((id) => !requested.includes(id));
    const batches: ApiRow[] = [];
    let status: string;
    if (other && !known) {
      status = 'already_in_shop';
    } else {
      let anyNew = false;
      let anyDuplicate = false;
      for (const b of raw.batches as Record<string, unknown>[]) {
        const stock = recordStockIn(call, sql, {
          p_batch_id: String(b.id).toLowerCase(),
          p_shop_id: ctx.shopId,
          p_product_id: productId,
          p_quantity: Number(b.quantity),
          p_expiry_date: b.expiry_date == null || b.expiry_date === '' ? null : String(b.expiry_date),
          p_cost_price_per_unit: buying === null ? null : buying / 100,
          p_received_at: ctx.now,
          p_idempotency_key: String(b.id).toLowerCase(),
        });
        batches.push(stock);
        if (stock.duplicate) anyDuplicate = true;
        else anyNew = true;
      }
      status = anyDuplicate && !anyNew ? 'duplicate' : adopt.created ? 'created' : 'stocked';
    }
    results.push({
      catalog_product_id: catalogId,
      status,
      created: adopt.created,
      product,
      packagings: adopt.packagings ?? [],
      barcodes: adopt.barcodes ?? [],
      batches,
    });
  }
  return { items: results };
}
