// product-lookup on Cloudflare: identifies a barcode for Smart Product Scan.
//
// Ported from supabase/functions/product-lookup/index.ts. Looks up this shop (its Durable
// Object), then the shared catalog (D1), then the Open Food Facts cache (D1), then Open Food
// Facts itself. Never writes shop products or the catalog. Rate-limited per shop in the shop's
// object. The pure helpers in logic.ts are shared with the old Edge Function and its tests.

import {
  OFF_TIMEOUT_MS,
  OFF_USER_AGENT,
  RATE_LIMIT_PER_MINUTE,
  cacheExpiresAt,
  canonicalizeBarcode,
  classifyOffHttp,
  isOffFoundStatus,
  mapOffProduct,
  mapShopProductRow,
  offProductUrl,
  shopBarcodeCandidates,
  suggestionFromCatalog,
  suggestionFromShopProduct,
  type CatalogBarcodeKind,
  type CatalogMatch,
  type CatalogVerification,
  type LookupResponse,
  type LookupSuggestion,
  type OffProductJson,
  type ProductCategory,
  type ShopProductPayload,
} from '../supabase/functions/product-lookup/logic.ts';
import { first, run } from './db/d1';
import type { Env } from './env';
import { authFor } from './api/authRoutes';
import { membership } from './d1/common';
import { shopStub } from './api/rpc';

/** The shop app calls this from another site, so the browser preflight must succeed or the scan never runs. */
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

function json(body: LookupResponse, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

async function findShopProduct(env: Env, shopId: string, candidates: string[]): Promise<ShopProductPayload | null> {
  const row = await shopStub(env, shopId).findByBarcodes(candidates);
  return row ? mapShopProductRow(row) : null;
}

async function findCatalogProduct(
  env: Env,
  candidates: string[]
): Promise<{ suggestion: LookupSuggestion; catalog: CatalogMatch } | null> {
  for (const code of candidates) {
    const link = await first<{ barcode: string; catalog_product_id: string; kind: string; units_per_package: number | null }>(
      env.DB,
      'SELECT barcode, catalog_product_id, kind, units_per_package FROM catalog_barcodes WHERE barcode = ?',
      code
    );
    if (!link?.catalog_product_id) continue;
    const product = await first<Record<string, string | number | null>>(
      env.DB,
      `SELECT id, name, brand, category, package_size, package_quantity, package_unit, image_url, image_path, ingredients, verification_status
         FROM catalog_products WHERE id = ?`,
      link.catalog_product_id
    );
    const name = typeof product?.name === 'string' ? product.name.trim() : '';
    if (!product || !name) continue;
    const unit = await first<{ barcode: string }>(
      env.DB,
      `SELECT barcode FROM catalog_barcodes WHERE catalog_product_id = ? AND kind = 'unit' LIMIT 1`,
      String(product.id)
    );
    const verificationStatus = product.verification_status as CatalogVerification;
    const kind = (link.kind as CatalogBarcodeKind) ?? 'unit';
    const packageQuantity = product.package_quantity == null ? null : Number(product.package_quantity);
    const catalog: CatalogMatch = {
      id: String(product.id),
      verificationStatus,
      kind,
      unitsPerPackage: link.units_per_package == null ? null : Number(link.units_per_package),
      packageQuantity: Number.isFinite(packageQuantity) ? packageQuantity : null,
      packageUnit: product.package_unit == null ? null : String(product.package_unit),
      unitBarcode: unit?.barcode ? String(unit.barcode) : null,
      ingredients: product.ingredients == null ? null : String(product.ingredients),
      imageUrl: product.image_url == null ? null : String(product.image_url),
      imagePath: product.image_path == null ? null : String(product.image_path),
    };
    return {
      catalog,
      suggestion: suggestionFromCatalog({
        barcode: kind === 'pack' && catalog.unitBarcode ? catalog.unitBarcode : String(link.barcode),
        name,
        brand: product.brand == null ? null : String(product.brand),
        size: product.package_size == null ? null : String(product.package_size),
        category: product.category as ProductCategory,
        verificationStatus,
        imageUrl: catalog.imageUrl,
        imagePath: catalog.imagePath,
        ingredients: catalog.ingredients,
        packageQuantity: catalog.packageQuantity,
        packageUnit: catalog.packageUnit,
      }),
    };
  }
  return null;
}

async function readCache(
  env: Env,
  barcode: string
): Promise<{ status: 'found' | 'not_found'; suggestion: LookupSuggestion | null } | null> {
  const data = await first<{ status: string; payload: string | null; expires_at: string }>(
    env.DB,
    'SELECT status, payload, expires_at FROM product_lookup_cache WHERE barcode = ?',
    barcode
  );
  if (!data) return null;
  if (new Date(data.expires_at).getTime() <= Date.now()) return null;
  if (data.status === 'not_found') return { status: 'not_found', suggestion: null };
  return { status: 'found', suggestion: data.payload ? (JSON.parse(data.payload) as LookupSuggestion) : null };
}

async function writeCache(env: Env, barcode: string, status: 'found' | 'not_found', payload: LookupSuggestion | null): Promise<void> {
  const now = new Date();
  await run(
    env.DB,
    `INSERT INTO product_lookup_cache (barcode, status, payload, provider, fetched_at, expires_at)
     VALUES (?, ?, ?, 'open_food_facts', ?, ?)
     ON CONFLICT (barcode) DO UPDATE SET status = excluded.status, payload = excluded.payload,
       provider = excluded.provider, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at`,
    barcode,
    status,
    status === 'found' ? JSON.stringify(payload) : null,
    now.toISOString(),
    cacheExpiresAt(status, now)
  );
}

async function lookupOff(
  barcode: string
): Promise<{ outcome: 'found' | 'not_found' | 'unavailable' | 'rate_limited'; suggestion: LookupSuggestion | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OFF_TIMEOUT_MS);
  try {
    const res = await fetch(offProductUrl(barcode), {
      headers: { 'User-Agent': OFF_USER_AGENT, Accept: 'application/json' },
      signal: controller.signal,
      redirect: 'follow',
    });
    const http = classifyOffHttp(res.status);
    if (http === 'rate_limited') return { outcome: 'rate_limited', suggestion: null };
    if (http === 'unavailable') return { outcome: 'unavailable', suggestion: null };
    if (http === 'not_found') return { outcome: 'not_found', suggestion: null };
    const body = (await res.json()) as OffProductJson;
    if (!isOffFoundStatus(body.status)) return { outcome: 'not_found', suggestion: null };
    const suggestion = mapOffProduct(barcode, body);
    if (!suggestion) return { outcome: 'not_found', suggestion: null };
    return { outcome: 'found', suggestion };
  } catch {
    return { outcome: 'unavailable', suggestion: null };
  } finally {
    clearTimeout(timer);
  }
}

export async function handleProductLookup(req: Request, env: Env): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ status: 'unavailable' }, 405);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return json({ status: 'forbidden' }, 401);

  let body: { barcode?: string; shopId?: string };
  try {
    body = await req.json();
  } catch {
    return json({ status: 'unavailable' }, 400);
  }

  const shopId = typeof body.shopId === 'string' ? body.shopId.trim() : '';
  const rawBarcode = typeof body.barcode === 'string' ? body.barcode : '';
  if (!shopId || !rawBarcode.trim()) return json({ status: 'unavailable' }, 400);

  const session = await authFor(env).userForToken(authHeader.slice(7).trim());
  if (!session || session.claims.recovery) return json({ status: 'forbidden' }, 401);
  const shop = shopId.toLowerCase();
  if (!(await membership(env.DB, shop, session.user.id))) return json({ status: 'forbidden' }, 403);

  const trimmed = rawBarcode.replace(/\s/g, '');
  const canonical = canonicalizeBarcode(rawBarcode);
  const repliedBarcode = canonical ?? trimmed;

  if (!(await shopStub(env, shop).allowLookup(RATE_LIMIT_PER_MINUTE))) {
    return json({ status: 'rate_limited', barcode: repliedBarcode }, 429);
  }

  const candidates = shopBarcodeCandidates(rawBarcode);
  const shopProduct = await findShopProduct(env, shop, candidates);
  if (shopProduct) {
    return json({
      status: 'found',
      barcode: repliedBarcode,
      matchSource: 'shop',
      suggestion: suggestionFromShopProduct(shopProduct),
      shopProduct,
    });
  }

  const catalogHit = await findCatalogProduct(env, candidates);
  if (catalogHit) {
    return json({
      status: 'found',
      barcode: repliedBarcode,
      matchSource: 'catalog',
      suggestion: catalogHit.suggestion,
      catalog: catalogHit.catalog,
    });
  }

  // Open Food Facts only accepts a GTIN. A shop code still matches the catalog above.
  if (!canonical) return json({ status: 'invalid_barcode', barcode: trimmed });

  const cached = await readCache(env, canonical);
  if (cached?.status === 'not_found') {
    return json({ status: 'not_found', barcode: canonical, matchSource: 'cache' });
  }
  if (cached?.status === 'found' && cached.suggestion) {
    return json({
      status: 'found',
      barcode: canonical,
      matchSource: 'cache',
      suggestion: cached.suggestion,
    });
  }

  const off = await lookupOff(canonical);
  if (off.outcome === 'unavailable') {
    return json({ status: 'unavailable', barcode: canonical });
  }
  if (off.outcome === 'rate_limited') {
    return json({ status: 'rate_limited', barcode: canonical }, 429);
  }
  if (off.outcome === 'not_found') {
    await writeCache(env, canonical, 'not_found', null);
    return json({ status: 'not_found', barcode: canonical, matchSource: 'open_food_facts' });
  }

  await writeCache(env, canonical, 'found', off.suggestion);
  return json({
    status: 'found',
    barcode: canonical,
    matchSource: 'open_food_facts',
    suggestion: off.suggestion!,
  });
}
