/**
 * /api/images/<key>: product pictures in R2, with the access rules the Supabase Storage policies
 * had. Keys are unchanged from Supabase: <shop-id>/<32 hex>.(webp|jpg) for a shop's pictures,
 * catalog/<catalog-id>.(webp|jpg) for shared catalog pictures.
 *
 *   GET     members of the shop; catalog pictures: any shop member or catalog admin
 *   PUT     shop pictures: active owners/managers/staff of an active shop
 *           catalog pictures: a member whose shop sells that catalog product (not replacing),
 *           or a platform admin with catalog.verify (may replace with ?upsert=1)
 *   DELETE  shop pictures that no product uses any more: members with products.edit
 */
import { all } from '../db/d1';
import type { Env } from '../env';
import { hasPlatformPermission, membership } from '../d1/common';
import { productImageShop } from '../shop/products';
import { shopStub, type Caller } from './rpc';

const MAX_BYTES = 262_144; // the bucket's file_size_limit in Supabase
const TYPES = ['image/webp', 'image/jpeg'];
const CATALOG = /^catalog\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(webp|jpg)$/;

/** Supabase Storage's error body: the app reads statusCode and message. */
function storageError(status: number, message: string): Response {
  return Response.json({ statusCode: String(status), error: message, message }, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function activeShops(env: Env, userId: string): Promise<{ shop_id: string; role: string; status: string }[]> {
  return all(
    env.DB,
    `SELECT m.shop_id, m.role, s.status FROM shop_members m JOIN shops s ON s.id = m.shop_id
      WHERE m.user_id = ? AND m.status = 'active'`,
    userId
  );
}

async function canRead(env: Env, key: string, caller: Caller): Promise<boolean> {
  const shopId = productImageShop(key);
  if (shopId) return Boolean(await membership(env.DB, shopId, caller.userId));
  if (CATALOG.test(key)) {
    return (await activeShops(env, caller.userId)).length > 0 || (await hasPlatformPermission(env.DB, caller.userId, 'catalog.verify'));
  }
  return false;
}

/** private.can_upload_catalog_image: one of the caller's active shops sells that catalog product. */
async function sellsCatalogProduct(env: Env, catalogId: string, caller: Caller): Promise<boolean> {
  for (const shop of await activeShops(env, caller.userId)) {
    if (shop.status !== 'active') continue;
    const rows = await shopStub(env, shop.shop_id).select('products', { catalog_product_id: catalogId, archived_at: null }, 1);
    if (rows.length) return true;
  }
  return false;
}

export async function handleImages(request: Request, env: Env, rawKey: string, caller: Caller | null): Promise<Response> {
  const key = decodeURIComponent(rawKey);
  if (!caller) return storageError(403, 'new row violates row-level security policy');
  const shopId = productImageShop(key);
  const catalog = CATALOG.exec(key);
  if (!shopId && !catalog) return storageError(400, 'Invalid key');

  if (request.method === 'GET' || request.method === 'HEAD') {
    if (!(await canRead(env, key, caller))) return storageError(400, 'Object not found');
    const object = await env.IMAGES.get(key);
    if (!object) return storageError(400, 'Object not found');
    const headers = new Headers({ 'Cache-Control': 'private, max-age=31536000, immutable' });
    object.writeHttpMetadata(headers);
    headers.set('ETag', object.httpEtag);
    return new Response(request.method === 'HEAD' ? null : object.body, { headers });
  }

  if (request.method === 'PUT' || request.method === 'POST') {
    const upsert = new URL(request.url).searchParams.get('upsert') === '1';
    const type = (request.headers.get('Content-Type') ?? '').split(';')[0].trim();
    let allowed = false;
    if (shopId) {
      const m = await membership(env.DB, shopId, caller.userId);
      allowed = Boolean(m && m.shop_status === 'active') && !upsert;
    } else if (catalog) {
      const admin = await hasPlatformPermission(env.DB, caller.userId, 'catalog.verify');
      allowed = admin || (!upsert && (await sellsCatalogProduct(env, catalog[1], caller)));
    }
    if (!allowed) return storageError(403, 'new row violates row-level security policy');
    if (!TYPES.includes(type)) return storageError(415, `mime type ${type || 'unknown'} is not supported`);
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > MAX_BYTES) return storageError(413, 'The object exceeded the maximum allowed size');
    if (!upsert && (await env.IMAGES.head(key))) return storageError(409, 'The resource already exists');
    await env.IMAGES.put(key, bytes, { httpMetadata: { contentType: type, cacheControl: 'max-age=31536000' } });
    return Response.json({ Key: `product-images/${key}`, path: key }, { headers: { 'Cache-Control': 'no-store' } });
  }

  if (request.method === 'DELETE') {
    // private.can_delete_product_image: shop pictures only, products.edit, and nothing uses it.
    const m = shopId ? await membership(env.DB, shopId, caller.userId) : null;
    if (!shopId || !m || !m.permissions.includes('products.edit')) return Response.json([], { headers: { 'Cache-Control': 'no-store' } });
    if ((await shopStub(env, shopId).select('products', { image_path: key }, 1)).length) {
      return Response.json([], { headers: { 'Cache-Control': 'no-store' } });
    }
    await env.IMAGES.delete(key);
    return Response.json([{ name: key }], { headers: { 'Cache-Control': 'no-store' } });
  }

  return storageError(405, 'Method not allowed');
}
