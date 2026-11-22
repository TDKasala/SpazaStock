/**
 * The shared catalog in D1 as the shop app uses it, ported from the Postgres functions of the
 * same names. Where Postgres joined the catalog with the shop's products, the shop's side comes
 * from its Durable Object (ctx.shop).
 */
import { all, first, run, type D1Like } from '../db/d1';
import { conflict, forbidden, invalid, notFound } from '../db/errors';
import { toApiRow, type ApiRow } from '../db/rows';
import { localDate } from '../shop/context';
import { CATEGORIES } from '../shop/products';
import type { CatalogLinkState } from '../shop/catalog';
import { assertShopRole, membership, uuidArg, type D1Ctx } from './common';

type Args = Record<string, unknown>;

/** What the D1 functions may ask a shop's object. */
export interface ShopReader {
  catalogLinks(today: string): Promise<CatalogLinkState[]>;
  usesCatalogProduct(catalogId: string): Promise<boolean>;
}

export type CatalogCtx = D1Ctx & { shop: (shopId: string) => ShopReader; imageExists?: (key: string) => Promise<boolean> };

const clean = (v: unknown) => String(v ?? '').replace(/\s/g, '');

async function requireMember(db: D1Like, ctx: D1Ctx, shopId: string | null) {
  const m = shopId ? await membership(db, shopId, ctx.userId) : null;
  if (!ctx.userId || !m) throw forbidden();
  return m;
}

async function barcodesFor(db: D1Like, ids: string[]) {
  const map = new Map<string, { barcode: string; kind: string; units_per_package: number | null }[]>();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const rows = await all<{ catalog_product_id: string; barcode: string; kind: string; units_per_package: number | null }>(
      db,
      `SELECT catalog_product_id, barcode, kind, units_per_package FROM catalog_barcodes
        WHERE catalog_product_id IN (${chunk.map(() => '?').join(', ')}) ORDER BY kind, barcode`,
      ...chunk
    );
    for (const r of rows) {
      const list = map.get(r.catalog_product_id) ?? [];
      list.push({ barcode: r.barcode, kind: r.kind, units_per_package: r.units_per_package });
      map.set(r.catalog_product_id, list);
    }
  }
  return map;
}

/** private.matches_stock_level */
function matchesStockLevel(level: string, sellable: number, minStock: number | null, expiring: boolean): boolean {
  if (level === 'in') return sellable > 0;
  if (level === 'out') return sellable <= 0;
  if (level === 'low') return minStock !== null && sellable <= minStock;
  if (level === 'expiring') return expiring;
  return true;
}

/** public.search_catalog: name, brand or barcode; filters by category, in-shop and stock level. */
export async function searchCatalog(db: D1Like, ctx: CatalogCtx, a: Args): Promise<ApiRow> {
  const shopId = uuidArg(a.p_shop_id);
  const m = await requireMember(db, ctx, shopId);
  const term = [...String(a.p_query ?? '').trim()].slice(0, 80).join('');
  const category = String(a.p_category ?? '').trim() || null;
  const stock = String(a.p_stock ?? '').trim() || null;
  const limit = Math.min(Math.max(a.p_limit == null ? 20 : Number(a.p_limit), 1), 50);
  const offset = Math.max(a.p_offset == null ? 0 : Number(a.p_offset), 0);
  if (category !== null && !CATEGORIES.includes(category)) throw invalid('Choose a known category.');
  if (stock !== null && !['in', 'out', 'low', 'expiring'].includes(stock)) throw invalid('Choose a known stock level.');

  const pattern = `%${term.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
  const candidates = await all<Record<string, string | number | null>>(
    db,
    `SELECT c.id, c.name, c.brand, c.category, c.package_size, c.package_quantity, c.package_unit, c.image_url, c.image_path,
            c.verification_status
       FROM catalog_products c
      WHERE (? = '' OR c.name LIKE ? ESCAPE '\\' OR c.brand LIKE ? ESCAPE '\\'
             OR EXISTS (SELECT 1 FROM catalog_barcodes b WHERE b.catalog_product_id = c.id AND b.barcode LIKE ? ESCAPE '\\'))
        AND (? IS NULL OR c.category = ?)
      ORDER BY c.name, c.id`,
    term,
    pattern,
    pattern,
    pattern,
    category,
    category
  );
  const links = new Map(
    (await ctx.shop(shopId!).catalogLinks(localDate(ctx.now, m.timezone))).map((l) => [l.catalog_product_id, l])
  );
  const inShop = a.p_in_shop == null ? null : Boolean(a.p_in_shop);
  const matching = candidates.filter((c) => {
    const link = links.get(String(c.id));
    if (inShop === true && !link) return false;
    if (inShop === false && link) return false;
    if (stock !== null && !matchesStockLevel(stock, link?.sellable ?? 0, link?.min_stock_units ?? null, link?.expiring ?? false)) return false;
    return true;
  });
  const page = matching.slice(offset, offset + limit);
  const barcodes = await barcodesFor(db, page.map((c) => String(c.id)));
  return {
    items: page.map((c) => {
      const link = links.get(String(c.id));
      return {
        ...c,
        shop_product_id: link?.product_id ?? null,
        shop_listed: link ? link.listed : null,
        barcodes: barcodes.get(String(c.id)) ?? [],
      };
    }),
    total: matching.length,
  };
}

/** public.list_common_catalog: the everyday products offered when a shop is set up. */
export async function listCommonCatalog(db: D1Like, ctx: CatalogCtx, a: Args): Promise<ApiRow> {
  const shopId = uuidArg(a.p_shop_id);
  const m = await requireMember(db, ctx, shopId);
  const items = await all<{ id: string; name: string; brand: string | null; category: string; package_size: string | null }>(
    db,
    'SELECT id, name, brand, category, package_size FROM catalog_products WHERE common = 1 ORDER BY name, id'
  );
  const links = new Map((await ctx.shop(shopId!).catalogLinks(localDate(ctx.now, m.timezone))).map((l) => [l.catalog_product_id, l]));
  const barcodes = await barcodesFor(db, items.map((i) => i.id));
  return {
    items: items.map((c) => ({ ...c, barcodes: barcodes.get(c.id) ?? [], shop_product_id: links.get(c.id)?.product_id ?? null })),
  };
}

/** public.link_catalog_barcode: a shop that sells a catalog product teaches it another barcode. */
export async function linkCatalogBarcode(db: D1Like, ctx: CatalogCtx, a: Args): Promise<ApiRow> {
  const shopId = uuidArg(a.p_shop_id);
  if (!shopId) throw forbidden();
  await assertShopRole(db, ctx, shopId, ['owner', 'manager', 'staff']);
  const catalogId = uuidArg(a.p_catalog_product_id);
  const barcode = clean(a.p_barcode);
  const units = a.p_units_per_package == null ? null : Number(a.p_units_per_package);
  if (!catalogId) throw invalid('Catalog product id is required.');
  if (barcode === '' || [...barcode].length > 64) throw invalid('Barcode is required (up to 64 characters).');
  if (a.p_kind !== 'alternate' && a.p_kind !== 'pack') throw invalid('Link an alternate barcode or a pack barcode.');
  if (a.p_kind === 'pack' && (units === null || units < 2 || units > 10_000)) throw invalid('A pack holds 2 to 10,000 units.');
  if (a.p_kind === 'alternate' && units !== null) throw invalid('An alternate barcode is one unit.');
  if (!(await ctx.shop(shopId).usesCatalogProduct(catalogId))) throw forbidden('This shop does not use that catalog product.');
  const existing = await first(db, 'SELECT * FROM catalog_barcodes WHERE barcode = ?', barcode);
  if (existing) {
    if (existing.catalog_product_id !== catalogId) throw conflict(`Barcode ${barcode} already belongs to another catalog product.`);
    return toApiRow('catalog_barcodes', existing)!;
  }
  if (!(await first(db, 'SELECT 1 AS x FROM catalog_products WHERE id = ?', catalogId))) throw notFound('Catalog product not found.');
  try {
    await run(
      db,
      `INSERT INTO catalog_barcodes (barcode, catalog_product_id, kind, units_per_package, source, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'user', ?, ?, ?)`,
      barcode,
      catalogId,
      String(a.p_kind),
      a.p_kind === 'pack' ? units : null,
      ctx.userId,
      ctx.now,
      ctx.now
    );
  } catch {
    const again = await first(db, 'SELECT * FROM catalog_barcodes WHERE barcode = ?', barcode);
    if (again?.catalog_product_id !== catalogId) throw conflict(`Barcode ${barcode} already belongs to another catalog product.`);
  }
  return toApiRow('catalog_barcodes', await first(db, 'SELECT * FROM catalog_barcodes WHERE barcode = ?', barcode))!;
}

const CATALOG_IMAGE = /^catalog\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(webp|jpg)$/;

/** public.set_catalog_image: the first picture uploaded for a catalog product becomes its picture. */
export async function setCatalogImage(db: D1Like, ctx: CatalogCtx, a: Args): Promise<string | null> {
  const shopId = uuidArg(a.p_shop_id);
  if (!shopId) throw forbidden();
  await assertShopRole(db, ctx, shopId, ['owner', 'manager', 'staff']);
  const catalogId = uuidArg(a.p_catalog_product_id);
  const path = String(a.p_image_path ?? '').trim() || null;
  if (!catalogId || !path) throw invalid('Catalog product and picture are required.');
  if (CATALOG_IMAGE.exec(path)?.[1] !== catalogId) throw invalid('This picture does not belong to that catalog product.');
  if (!(await ctx.shop(shopId).usesCatalogProduct(catalogId))) throw forbidden('This shop does not use that catalog product.');
  const row = await first<{ image_path: string | null }>(db, 'SELECT image_path FROM catalog_products WHERE id = ?', catalogId);
  if (!row) throw notFound('Catalog product not found.');
  if (row.image_path !== null) return row.image_path;
  if (!ctx.imageExists || !(await ctx.imageExists(path))) throw invalid('The picture has not been uploaded.');
  await run(db, 'UPDATE catalog_products SET image_path = ? WHERE id = ? AND image_path IS NULL', path, catalogId);
  return (await first<{ image_path: string | null }>(db, 'SELECT image_path FROM catalog_products WHERE id = ?', catalogId))!.image_path;
}

/** public.list_shop_catalog_review: the common products, with what this shop sells, hides or skips. */
export async function listShopCatalogReview(db: D1Like, ctx: CatalogCtx, a: Args): Promise<ApiRow> {
  const shopId = uuidArg(a.p_shop_id);
  const m = await requireMember(db, ctx, shopId);
  const term = [...String(a.p_query ?? '').trim()].slice(0, 80).join('');
  const status = String(a.p_status ?? '').trim() || null;
  const category = String(a.p_category ?? '').trim() || null;
  const stock = String(a.p_stock ?? '').trim() || null;
  const limit = Math.min(Math.max(a.p_limit == null ? 20 : Number(a.p_limit), 1), 50);
  const offset = Math.max(a.p_offset == null ? 0 : Number(a.p_offset), 0);
  if (status !== null && !['open', 'selling', 'hidden'].includes(status)) throw invalid('Choose open, selling, or hidden.');
  if (category !== null && !CATEGORIES.includes(category)) throw invalid('Choose a known category.');
  if (stock !== null && !['in', 'out', 'low', 'expiring'].includes(stock)) throw invalid('Choose a known stock level.');

  const common = await all<Record<string, string | number | null>>(
    db,
    'SELECT id, name, brand, category, package_size, image_url, image_path FROM catalog_products WHERE common = 1 ORDER BY name, id'
  );
  const links = new Map((await ctx.shop(shopId!).catalogLinks(localDate(ctx.now, m.timezone))).map((l) => [l.catalog_product_id, l]));
  let selling = 0;
  let hidden = 0;
  let open = 0;
  for (const c of common) {
    const link = links.get(String(c.id));
    if (!link) open++;
    else if (link.listed) selling++;
    else hidden++;
  }

  const pattern = `%${term.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
  const termMatches = new Set(
    term === ''
      ? common.map((c) => String(c.id))
      : (
          await all<{ id: string }>(
            db,
            `SELECT c.id FROM catalog_products c
              WHERE c.common = 1 AND (c.name LIKE ? ESCAPE '\\' OR c.brand LIKE ? ESCAPE '\\'
                OR EXISTS (SELECT 1 FROM catalog_barcodes b WHERE b.catalog_product_id = c.id AND b.barcode LIKE ? ESCAPE '\\'))`,
            pattern,
            pattern,
            pattern
          )
        ).map((r) => r.id)
  );
  const matching = common.filter((c) => {
    const link = links.get(String(c.id));
    if (!termMatches.has(String(c.id))) return false;
    if (category !== null && c.category !== category) return false;
    if (status === 'open' && link) return false;
    if (status === 'selling' && !link?.listed) return false;
    if (status === 'hidden' && (!link || link.listed)) return false;
    if (stock !== null && !matchesStockLevel(stock, link?.sellable ?? 0, link?.min_stock_units ?? null, link?.expiring ?? false)) return false;
    return true;
  });
  const page = matching.slice(offset, offset + limit);
  const barcodes = await barcodesFor(db, page.map((c) => String(c.id)));
  return {
    items: page.map((c) => {
      const link = links.get(String(c.id));
      return { ...c, shop_product_id: link?.product_id ?? null, listed: link ? link.listed : null, barcodes: barcodes.get(String(c.id)) ?? [] };
    }),
    total: matching.length,
    progress: { total: common.length, selling, hidden, open },
  };
}
