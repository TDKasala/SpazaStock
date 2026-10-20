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
