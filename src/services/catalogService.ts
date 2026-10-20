import type { Product, ProductBarcode, ProductCategory, ProductPackaging } from '../types';
import { db, withWriteLock } from '../lib/db';
import { emitDataChanged } from '../lib/events';
import { newId } from '../lib/ids';
import { getSupabase } from '../lib/supabase';
import { mapBarcodeRow, mapPackagingRow, mapProductRow } from '../sync/syncEngine';

export interface CatalogBarcodeHit {
  barcode: string;
  kind: 'unit' | 'alternate' | 'pack';
  unitsPerPackage: number | null;
}

/** Shared identity only. Prices, quantities and expiry are not part of a search hit. */
export interface CatalogSearchHit {
  id: string;
  name: string;
  brand: string | null;
  category: ProductCategory;
  packageSize: string | null;
  packageQuantity: number | null;
  packageUnit: string | null;
  imageUrl: string | null;
  imagePath: string | null;
  verificationStatus: string;
  /** Set when this shop already has an active product for the catalogue row. */
  shopProductId: string | null;
  barcodes: CatalogBarcodeHit[];
}

export interface CatalogSearchPage {
  items: CatalogSearchHit[];
  total: number;
}

export interface AdoptedCatalogProduct {
  created: boolean;
  product: Product;
  packagings: ProductPackaging[];
  barcodes: ProductBarcode[];
}

export interface CatalogServiceError {
  code: string;
  message: string;
}

type Result<T> = { data: T; error?: undefined } | { data?: undefined; error: CatalogServiceError };

const NOT_CONFIGURED: CatalogServiceError = { code: 'not_configured', message: 'Supabase is not configured.' };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function mapHit(raw: unknown): CatalogSearchHit {
  const row = asRecord(raw);
  const barcodes = Array.isArray(row.barcodes) ? row.barcodes : [];
  return {
    id: String(row.id),
    name: String(row.name ?? ''),
    brand: (row.brand as string | null) ?? null,
    category: (row.category as ProductCategory) ?? 'other',
    packageSize: (row.package_size as string | null) ?? null,
    packageQuantity: row.package_quantity == null ? null : Number(row.package_quantity),
    packageUnit: (row.package_unit as string | null) ?? null,
    imageUrl: (row.image_url as string | null) ?? null,
    imagePath: (row.image_path as string | null) ?? null,
    verificationStatus: String(row.verification_status ?? ''),
    shopProductId: (row.shop_product_id as string | null) ?? null,
    barcodes: barcodes.map((item) => {
      const code = asRecord(item);
      return {
        barcode: String(code.barcode ?? ''),
        kind: (code.kind as CatalogBarcodeHit['kind']) ?? 'unit',
        unitsPerPackage: code.units_per_package == null ? null : Number(code.units_per_package),
      };
    }),
  };
}

export async function searchCatalog(
  shopId: string,
  query: string,
  options: { limit?: number; offset?: number } = {}
): Promise<Result<CatalogSearchPage>> {
  const supabase = getSupabase();
  if (!supabase) return { error: NOT_CONFIGURED };
  const { data, error } = await supabase.rpc('search_catalog', {
    p_shop_id: shopId,
    p_query: query,
    p_limit: options.limit ?? 20,
    p_offset: options.offset ?? 0,
  });
  if (error) return { error: { code: error.code ?? 'error', message: error.message } };
  const page = asRecord(data);
  const items = Array.isArray(page.items) ? page.items.map(mapHit) : [];
  return { data: { items, total: Number(page.total ?? items.length) } };
}

/**
 * Keeps one catalogue product in this shop. Prices are stored only on the new shop row.
 * A product this shop already has is returned unchanged, including its prices and stock.
 */
export async function adoptCatalogProduct(
  shopId: string,
  catalogProductId: string,
  prices: { buyingPrice: number | null; sellingPrice: number | null }
): Promise<Result<AdoptedCatalogProduct>> {
  const supabase = getSupabase();
  if (!supabase) return { error: NOT_CONFIGURED };
  const { data, error } = await supabase.rpc('adopt_catalog_product', {
    p_id: newId(),
    p_shop_id: shopId,
    p_catalog_product_id: catalogProductId,
    p_buying_price: prices.buyingPrice,
    p_selling_price: prices.sellingPrice,
    p_created_at: new Date().toISOString(),
  });
  if (error) return { error: { code: error.code ?? 'error', message: error.message } };

  const body = asRecord(data);
  const product = mapProductRow(asRecord(body.product));
  const packagings = (Array.isArray(body.packagings) ? body.packagings : []).map((row) =>
    mapPackagingRow(asRecord(row))
  );
  const barcodes = (Array.isArray(body.barcodes) ? body.barcodes : []).map((row) => mapBarcodeRow(asRecord(row)));

  await withWriteLock(() =>
    db.transaction('rw', [db.products, db.packagings, db.barcodes], async () => {
      await db.products.put(product);
      if (packagings.length > 0) await db.packagings.bulkPut(packagings);
      if (barcodes.length > 0) await db.barcodes.bulkPut(barcodes);
    })
  );
  emitDataChanged('local');
  return { data: { created: body.created === true, product, packagings, barcodes } };
}

export interface CommonCatalogItem {
  id: string;
  name: string;
  brand: string | null;
  category: ProductCategory;
  packageSize: string | null;
  shopProductId: string | null;
  barcodes: CatalogBarcodeHit[];
}

export interface CatalogSelection {
  catalogProductId: string;
  buyingPrice: number | null;
  sellingPrice: number | null;
}

function mapCommonItem(row: Record<string, unknown>): CommonCatalogItem {
  const barcodes = Array.isArray(row.barcodes) ? row.barcodes : [];
  return {
    id: String(row.id),
    name: String(row.name),
    brand: row.brand == null ? null : String(row.brand),
    category: String(row.category) as ProductCategory,
    packageSize: row.package_size == null ? null : String(row.package_size),
    shopProductId: row.shop_product_id == null ? null : String(row.shop_product_id),
    barcodes: barcodes.map((entry) => {
      const barcode = asRecord(entry);
      return {
        barcode: String(barcode.barcode),
        kind: barcode.kind as CatalogBarcodeHit['kind'],
        unitsPerPackage: barcode.units_per_package == null ? null : Number(barcode.units_per_package),
      };
    }),
  };
}

/** Common catalogue rows for a new shop. Prices from other shops are not included. */
export async function listCommonCatalog(shopId: string): Promise<Result<CommonCatalogItem[]>> {
  const supabase = getSupabase();
  if (!supabase) return { error: NOT_CONFIGURED };
  const { data, error } = await supabase.rpc('list_common_catalog', { p_shop_id: shopId });
  if (error) return { error: { code: error.code ?? 'error', message: error.message } };
  const items = asRecord(data).items;
  return { data: (Array.isArray(items) ? items : []).map((row) => mapCommonItem(asRecord(row))) };
}

/**
 * Creates one shop product for each confirmed common catalogue row.
 * A second call returns the existing row and does not change its prices.
 * An empty selection skips setup and adds nothing.
 */
export async function confirmShopCatalog(
  shopId: string,
  selections: CatalogSelection[]
): Promise<Result<{ products: AdoptedCatalogProduct[] }>> {
  const supabase = getSupabase();
  if (!supabase) return { error: NOT_CONFIGURED };
  const { data, error } = await supabase.rpc('confirm_shop_catalog', {
    p_shop_id: shopId,
    p_selections: selections.map((item) => ({
      catalog_product_id: item.catalogProductId,
      buying_price: item.buyingPrice,
      selling_price: item.sellingPrice,
    })),
  });
  if (error) return { error: { code: error.code ?? 'error', message: error.message } };

  const rows = asRecord(data).products;
  const products = (Array.isArray(rows) ? rows : []).map((entry) => {
    const body = asRecord(entry);
    return {
      created: body.created === true,
      product: mapProductRow(asRecord(body.product)),
      packagings: (Array.isArray(body.packagings) ? body.packagings : []).map((row) =>
        mapPackagingRow(asRecord(row))
      ),
      barcodes: (Array.isArray(body.barcodes) ? body.barcodes : []).map((row) => mapBarcodeRow(asRecord(row))),
    };
  });

  if (products.length > 0) {
    await withWriteLock(() =>
      db.transaction('rw', [db.products, db.packagings, db.barcodes], async () => {
        for (const row of products) {
          await db.products.put(row.product);
          if (row.packagings.length > 0) await db.packagings.bulkPut(row.packagings);
          if (row.barcodes.length > 0) await db.barcodes.bulkPut(row.barcodes);
        }
      })
    );
    emitDataChanged('local');
  }
  return { data: { products } };
}
