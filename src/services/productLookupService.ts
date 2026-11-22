import { getSupabase } from '../lib/supabase';
import { db } from '../lib/db';
import type {
  CatalogMatch,
  Product,
  ProductCategory,
  ProductLookupResult,
  ProductLookupSuggestion,
} from '../types';
import type { ProductFormValues } from '../components/stock/ProductFormFields';

/**
 * Asks the server to identify a barcode (this shop, then the shared catalog, then Open Food Facts).
 * Soft-fails: network errors, missing client, and unexpected bodies become `unavailable`
 * so registration and stock-in are never blocked.
 */
export async function lookupProductByBarcode(barcode: string, shopId: string): Promise<ProductLookupResult> {
  const client = getSupabase();
  if (!client || !navigator.onLine) return { status: 'unavailable' };

  try {
    const workerUrl = import.meta.env.VITE_PRODUCT_LOOKUP_URL?.trim();
    const { data, error } = workerUrl
      ? await lookupViaWorker(client, workerUrl, barcode, shopId)
      : await client.functions.invoke<ProductLookupResult>('product-lookup', { body: { barcode, shopId } });
    if (error || !data || typeof data !== 'object' || !('status' in data)) {
      return { status: 'unavailable' };
    }
    return normalizeLookupResult(data);
  } catch {
    return { status: 'unavailable' };
  }
}

/**
 * Cloudflare Worker route (VITE_PRODUCT_LOOKUP_URL, e.g. /api/product-lookup). Mirrors
 * functions.invoke: the user's access token as Bearer, and any non-2xx answer is an error.
 */
async function lookupViaWorker(
  client: NonNullable<ReturnType<typeof getSupabase>>,
  url: string,
  barcode: string,
  shopId: string
): Promise<{ data: ProductLookupResult | null; error: unknown }> {
  const { data: auth } = await client.auth.getSession();
  const token = auth.session?.access_token;
  if (!token) return { data: null, error: 'signed_out' };
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ barcode, shopId }),
  });
  if (!res.ok) return { data: null, error: res.status };
  return { data: (await res.json()) as ProductLookupResult, error: null };
}

function normalizeLookupResult(data: ProductLookupResult): ProductLookupResult {
  const status = data.status;
  if (
    status !== 'found' &&
    status !== 'not_found' &&
    status !== 'unavailable' &&
    status !== 'rate_limited' &&
    status !== 'invalid_barcode' &&
    status !== 'forbidden'
  ) {
    return { status: 'unavailable' };
  }

  const shopProduct = data.shopProduct ? coerceShopProduct(data.shopProduct) : undefined;
  return {
    status,
    barcode: data.barcode,
    matchSource: data.matchSource,
    suggestion: data.suggestion,
    shopProduct: shopProduct ?? undefined,
    catalog: coerceCatalog(data.catalog),
  };
}

function coerceCatalog(raw: CatalogMatch | undefined): CatalogMatch | undefined {
  if (!raw || typeof raw !== 'object' || !raw.id || !raw.verificationStatus || !raw.kind) return undefined;
  const record = raw as CatalogMatch & { image_path?: string | null };
  return {
    ...raw,
    imagePath: record.imagePath ?? record.image_path ?? null,
  };
}

/** Accepts camelCase from the Edge Function (and tolerates accidental snake_case). */
function coerceShopProduct(raw: Product | Record<string, unknown>): Product | null {
  const r = raw as Record<string, unknown>;
  const id = String(r.id ?? '');
  const shopId = String(r.shopId ?? r.shop_id ?? '');
  const barcode = String(r.barcode ?? '');
  const name = String(r.name ?? '');
  if (!id || !shopId || !barcode || !name) return null;
  return {
    id,
    shopId,
    barcode,
    name,
    category: (r.category as ProductCategory) ?? 'other',
    buyingPrice: (r.buyingPrice ?? r.buying_price ?? null) as number | null,
    sellingPrice: (r.sellingPrice ?? r.selling_price ?? null) as number | null,
    createdAt: String(r.createdAt ?? r.created_at ?? new Date().toISOString()),
    updatedAt: String(r.updatedAt ?? r.updated_at ?? new Date().toISOString()),
    archivedAt: (r.archivedAt ?? r.archived_at ?? null) as string | null,
    brand: (r.brand ?? null) as string | null,
    size: (r.size ?? null) as string | null,
    imagePath: (r.imagePath ?? r.image_path ?? null) as string | null,
    listed: r.listed === false ? false : true,
    catalogProductId: (r.catalogProductId ?? r.catalog_product_id ?? null) as string | null,
  };
}

/** Writes a server-known shop product into Dexie without enqueueing an outbox item. */
export async function cacheShopProductLocally(product: Product): Promise<Product> {
  await db.products.put(product);
  return product;
}

/** Prefill register form fields from an external suggestion; prices stay blank for the user. */
export function productFormFromSuggestion(barcode: string, suggestion: ProductLookupSuggestion): ProductFormValues {
  return {
    barcode,
    name: suggestion.name.value ?? '',
    category: suggestion.category.value ?? 'groceries',
    buyingPrice: '',
    sellingPrice: '',
    brand: suggestion.brand.value ?? '',
    size: suggestion.size.value ?? '',
  };
}
