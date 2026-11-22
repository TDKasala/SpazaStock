/**
 * POST /api/rpc/:name — the app's supabase.rpc(name, args). Shop-ledger functions run in that
 * shop's Durable Object after the caller's membership is resolved from D1; shared functions run
 * on D1. Replaces PostgREST + SECURITY DEFINER functions + RLS.
 */
import { all, first, type D1Like } from '../db/d1';
import { DbError, forbidden } from '../db/errors';
import type { Env } from '../env';
import type { ShopObject } from '../shop/ShopObject';
import { SHOP_FUNCTIONS } from '../shop/functions';
import type { CatalogFact, ShopCtx, ShopInputs } from '../shop/context';
import { productImageShop } from '../shop/products';
import { ANON_FUNCTIONS, D1_FUNCTIONS } from '../d1/functions';
import { membership } from '../d1/common';
import type { CatalogCtx } from '../d1/catalog';
import { applyEffects } from '../d1/push';
import { fail, ok } from './http';

export interface Caller {
  userId: string;
  email: string;
}

/** The shop object's RPC surface (typed here: the generated stub types cannot express ApiRow). */
export interface ShopApi {
  rpc: ShopObject['rpc'];
  runAlerts: ShopObject['runAlerts'];
  pull: ShopObject['pull'];
  select: ShopObject['select'];
  resolveDiscrepancy: ShopObject['resolveDiscrepancy'];
  importBundle: ShopObject['importBundle'];
  stats: ShopObject['stats'];
  catalogLinks: ShopObject['catalogLinks'];
  usesCatalogProduct: ShopObject['usesCatalogProduct'];
}

export function shopStub(env: Env, shopId: string): ShopApi {
  return env.SHOP.getByName(shopId) as unknown as ShopApi;
}

/** Who the caller is in a shop, as the shop object needs it. Non-members get an empty role. */
export async function shopCtx(db: D1Like, shopId: string, caller: Caller | null, now: string): Promise<ShopCtx> {
  const m = await membership(db, shopId, caller?.userId ?? null);
  const shop = m ? null : await first<{ status: string; timezone: string }>(db, 'SELECT status, timezone FROM shops WHERE id = ?', shopId);
  return {
    shopId,
    userId: m ? caller!.userId : null,
    role: m?.role ?? null,
    permissions: m?.permissions ?? [],
    shopActive: (m?.shop_status ?? shop?.status ?? 'active') === 'active',
    timezone: m?.timezone ?? shop?.timezone ?? 'Africa/Johannesburg',
    now,
  };
}

/** Catalog products (with their barcodes) by id, for functions that adopt several at once. */
export async function catalogEntries(env: Env, ids: string[]): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const raw of new Set(ids.map((i) => i.toLowerCase()).filter((i) => /^[0-9a-f-]{36}$/.test(i)))) {
    const product = await first<Record<string, unknown>>(
      env.DB,
      'SELECT id, name, brand, category, package_size, image_path, common FROM catalog_products WHERE id = ?',
      raw
    );
    if (!product) continue;
    out[raw] = {
      product: { ...product, common: product.common === 1 },
      barcodes: await all(env.DB, 'SELECT barcode, kind, units_per_package, created_at FROM catalog_barcodes WHERE catalog_product_id = ?', raw),
    };
  }
  return out;
}

/** Facts from D1/R2 a shop function needs (see ShopInputs). */
async function shopInputs(env: Env, name: string, shopId: string, args: Record<string, unknown>): Promise<ShopInputs> {
  const inputs: ShopInputs = {};
  const catalogId = typeof args.p_catalog_product_id === 'string' ? args.p_catalog_product_id : null;
  if (catalogId) {
    const row = await first<CatalogFact>(env.DB, 'SELECT id, image_path FROM catalog_products WHERE id = ?', catalogId.toLowerCase());
    if (row) inputs.catalog = { [row.id]: row };
  }
  if (name === 'adopt_catalog_product' && catalogId) {
    const id = catalogId.toLowerCase();
    const product = await first(env.DB, 'SELECT id, name, brand, category, package_size, image_path FROM catalog_products WHERE id = ?', id);
    if (product) {
      inputs.catalogProduct = product;
      inputs.catalogBarcodes = await all(
        env.DB,
        'SELECT barcode, kind, units_per_package, created_at FROM catalog_barcodes WHERE catalog_product_id = ?',
        id
      );
    }
  }
  const choices = name === 'confirm_shop_catalog' ? args.p_selections : name === 'review_shop_catalog' ? args.p_decisions : null;
  if (Array.isArray(choices)) {
    inputs.catalogEntries = await catalogEntries(env, (choices as Record<string, unknown>[]).map((s) => String(s?.catalog_product_id ?? '')));
  }
  if (name === 'set_product_image' && typeof args.p_image_path === 'string') {
    const path = args.p_image_path.trim();
    if (path && productImageShop(path) === shopId && (await env.IMAGES.head(path))) inputs.imagesPresent = [path];
  }
  return inputs;
}

export async function handleRpc(env: Env, name: string, args: Record<string, unknown>, caller: Caller | null): Promise<Response> {
  const now = new Date().toISOString();
  try {
    if (!caller && !ANON_FUNCTIONS.has(name)) throw new DbError('42501', `permission denied for function ${name}`);

    if (SHOP_FUNCTIONS[name]) {
      const shopId = typeof args.p_shop_id === 'string' ? args.p_shop_id.toLowerCase() : null;
      if (!shopId || !/^[0-9a-f-]{36}$/.test(shopId)) throw forbidden();
      const ctx = await shopCtx(env.DB, shopId, caller, now);
      // Not a member: refuse here, without waking the shop's object.
      if (!ctx.role) throw forbidden();
      const result = await shopStub(env, shopId).rpc(name, ctx, await shopInputs(env, name, shopId, args), args);
      if ('error' in result) return fail(new DbError(result.error.code, result.error.message));
      if (result.effects.length) await applyEffects(env.DB, shopId, result.effects, now);
      return ok(result.data);
    }

    const d1Fn = D1_FUNCTIONS[name];
    if (d1Fn) {
      const ctx: CatalogCtx = {
        userId: caller?.userId ?? null,
        email: caller?.email ?? null,
        now,
        shop: (shopId) => ({
          catalogLinks: (today) => shopStub(env, shopId).catalogLinks(shopId, today),
          usesCatalogProduct: (catalogId) => shopStub(env, shopId).usesCatalogProduct(catalogId),
        }),
        imageExists: async (key) => Boolean(await env.IMAGES.head(key)),
      };
      return ok(await d1Fn(env.DB, ctx, args));
    }

    if (name === 'get_push_public_key') {
      if (!caller) throw new DbError('42501', 'Sign in to turn on notifications.');
      return ok(env.VAPID_PUBLIC_KEY ?? null);
    }

    throw new DbError('42883', `Could not find the function public.${name}`);
  } catch (err) {
    return fail(err);
  }
}
