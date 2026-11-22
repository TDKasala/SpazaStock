// product-lookup on Cloudflare Workers: a port of supabase/functions/product-lookup/index.ts.
//
// Served same-origin at POST /api/product-lookup, so the browser needs no CORS preflight (the
// CORS headers stay so a separately hosted front end still works during the move). Still reads
// the Supabase database with the user's JWT for the membership check and the service role for
// the shared catalog, cache and rate limit, exactly like the Edge Function. When the data moves
// off Supabase (see docs/cloudflare-migration.md, phase 3) only the queries below change; the
// pure helpers in logic.ts stay as they are.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
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
  rateWindowStart,
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
import type { Env } from './env';

const PRODUCT_COLUMNS =
  'id, shop_id, barcode, name, category, buying_price, selling_price, created_at, updated_at, archived_at, brand, size, image_path, listed, catalog_product_id';

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

function serviceClient(env: Env): SupabaseClient {
  return createClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function userClient(env: Env, authHeader: string): SupabaseClient {
  return createClient(env.SUPABASE_URL!, env.SUPABASE_ANON_KEY!, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function assertActiveMember(user: SupabaseClient, shopId: string, userId: string): Promise<boolean> {
  const { data, error } = await user
    .from('shop_members')
    .select('id')
    .eq('shop_id', shopId)
    .eq('user_id', userId)
    .eq('status', 'active')
    .maybeSingle();
  return !error && Boolean(data);
}

async function checkRateLimit(admin: SupabaseClient, shopId: string): Promise<boolean> {
  const windowStart = rateWindowStart();
  const { data: existing } = await admin
    .from('product_lookup_rate')
    .select('request_count')
    .eq('shop_id', shopId)
    .eq('window_start', windowStart)
    .maybeSingle();

  const count = existing?.request_count ?? 0;
  if (count >= RATE_LIMIT_PER_MINUTE) return false;

  if (existing) {
    const { error } = await admin
      .from('product_lookup_rate')
      .update({ request_count: count + 1 })
      .eq('shop_id', shopId)
      .eq('window_start', windowStart);
    return !error;
  }

  const { error } = await admin.from('product_lookup_rate').insert({
    shop_id: shopId,
    window_start: windowStart,
    request_count: 1,
  });
  // A concurrent insert races: re-read and accept if still under the limit.
  if (error) {
    const { data: again } = await admin
      .from('product_lookup_rate')
      .select('request_count')
      .eq('shop_id', shopId)
      .eq('window_start', windowStart)
      .maybeSingle();
    if (!again || again.request_count >= RATE_LIMIT_PER_MINUTE) return false;
    await admin
      .from('product_lookup_rate')
      .update({ request_count: again.request_count + 1 })
      .eq('shop_id', shopId)
      .eq('window_start', windowStart);
  }
  return true;
}

async function findShopProduct(
  admin: SupabaseClient,
  shopId: string,
  candidates: string[]
): Promise<ShopProductPayload | null> {
  const { data: own } = await admin
    .from('products')
    .select(PRODUCT_COLUMNS)
    .eq('shop_id', shopId)
    .in('barcode', candidates)
    .limit(1)
    .maybeSingle();
  if (own) return mapShopProductRow(own as Record<string, unknown>);

  const { data: link } = await admin
    .from('product_barcodes')
    .select('product_id')
    .eq('shop_id', shopId)
    .in('barcode', candidates)
    .is('unlinked_at', null)
    .limit(1)
    .maybeSingle();
  if (!link?.product_id) return null;

  const { data: viaAlias } = await admin
    .from('products')
    .select(PRODUCT_COLUMNS)
    .eq('shop_id', shopId)
    .eq('id', link.product_id)
    .maybeSingle();
  return viaAlias ? mapShopProductRow(viaAlias as Record<string, unknown>) : null;
}

async function findCatalogProduct(
  admin: SupabaseClient,
  candidates: string[]
): Promise<{ suggestion: LookupSuggestion; catalog: CatalogMatch } | null> {
  for (const code of candidates) {
    const { data: link } = await admin
      .from('catalog_barcodes')
      .select('barcode, catalog_product_id, kind, units_per_package')
      .eq('barcode', code)
      .maybeSingle();
    if (!link?.catalog_product_id) continue;

    const { data: product } = await admin
      .from('catalog_products')
      .select(
        'id, name, brand, category, package_size, package_quantity, package_unit, image_url, image_path, ingredients, verification_status'
      )
      .eq('id', link.catalog_product_id)
      .maybeSingle();
    const name = typeof product?.name === 'string' ? product.name.trim() : '';
    if (!product || !name) continue;

    const { data: unit } = await admin
      .from('catalog_barcodes')
      .select('barcode')
      .eq('catalog_product_id', product.id)
      .eq('kind', 'unit')
      .limit(1)
      .maybeSingle();

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
  admin: SupabaseClient,
  barcode: string
): Promise<{ status: 'found' | 'not_found'; suggestion: LookupSuggestion | null } | null> {
  const { data } = await admin
    .from('product_lookup_cache')
    .select('status, payload, expires_at')
    .eq('barcode', barcode)
    .maybeSingle();
  if (!data) return null;
  if (new Date(data.expires_at).getTime() <= Date.now()) return null;
  if (data.status === 'not_found') return { status: 'not_found', suggestion: null };
  return { status: 'found', suggestion: data.payload as LookupSuggestion };
}

async function writeCache(
  admin: SupabaseClient,
  barcode: string,
  status: 'found' | 'not_found',
  payload: LookupSuggestion | null
): Promise<void> {
  const now = new Date();
  await admin.from('product_lookup_cache').upsert({
    barcode,
    status,
    payload: status === 'found' ? payload : null,
    provider: 'open_food_facts',
    fetched_at: now.toISOString(),
    expires_at: cacheExpiresAt(status, now),
  });
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

  const user = userClient(env, authHeader);
  const {
    data: { user: authUser },
    error: authError,
  } = await user.auth.getUser();
  if (authError || !authUser) return json({ status: 'forbidden' }, 401);

  if (!(await assertActiveMember(user, shopId, authUser.id))) {
    return json({ status: 'forbidden' }, 403);
  }

  const trimmed = rawBarcode.replace(/\s/g, '');
  const canonical = canonicalizeBarcode(rawBarcode);
  const repliedBarcode = canonical ?? trimmed;

  const admin = serviceClient(env);
  if (!(await checkRateLimit(admin, shopId))) {
    return json({ status: 'rate_limited', barcode: repliedBarcode }, 429);
  }

  const candidates = shopBarcodeCandidates(rawBarcode);
  const shopProduct = await findShopProduct(admin, shopId, candidates);
  if (shopProduct) {
    return json({
      status: 'found',
      barcode: repliedBarcode,
      matchSource: 'shop',
      suggestion: suggestionFromShopProduct(shopProduct),
      shopProduct,
    });
  }

  const catalogHit = await findCatalogProduct(admin, candidates);
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

  const cached = await readCache(admin, canonical);
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
    await writeCache(admin, canonical, 'not_found', null);
    return json({ status: 'not_found', barcode: canonical, matchSource: 'open_food_facts' });
  }

  await writeCache(admin, canonical, 'found', off.suggestion);
  return json({
    status: 'found',
    barcode: canonical,
    matchSource: 'open_food_facts',
    suggestion: off.suggestion!,
  });
}
