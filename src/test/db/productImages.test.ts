// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import {
  addMember,
  createDatabase,
  createShop,
  createUser,
  errorCode,
  newProduct,
  query,
  rpc,
  type Caller,
  type User,
} from './harness';

let pg: PGlite;
let owner: User;
let manager: User;
let staff: User;
let outsider: User;
let shop: string;
let otherShop: string;

interface ImageResult {
  product: { id: string; image_path: string | null };
  previous_path: string | null;
}

beforeAll(async () => {
  pg = await createDatabase();
  owner = await createUser(pg);
  manager = await createUser(pg);
  staff = await createUser(pg);
  outsider = await createUser(pg);
  shop = await createShop(pg, owner);
  otherShop = await createShop(pg, outsider);
  await addMember(pg, owner, shop, manager, 'manager');
  await addMember(pg, owner, shop, staff, 'staff');
}, 60_000);

afterAll(async () => {
  await pg?.close();
});

function imagePath(shopId = shop, ext = 'webp'): string {
  return `${shopId}/${randomBytes(16).toString('hex')}.${ext}`;
}

function upload(caller: Caller, path: string) {
  return query(pg, caller, `insert into storage.objects (bucket_id, name) values ('product-images', $1)`, [path]);
}

async function visible(caller: Caller, path: string): Promise<boolean> {
  const rows = await query(pg, caller, `select name from storage.objects where bucket_id = 'product-images' and name = $1`, [path]);
  return rows.length === 1;
}

async function remove(caller: Caller, path: string): Promise<boolean> {
  const rows = await query(
    pg,
    caller,
    `delete from storage.objects where bucket_id = 'product-images' and name = $1 returning name`,
    [path]
  );
  return rows.length === 1;
}

function setImage(caller: Caller, productId: string, path: string | null, shopId = shop) {
  return rpc<ImageResult>(pg, caller, 'set_product_image', {
    p_shop_id: shopId,
    p_product_id: productId,
    p_image_path: path,
  });
}

describe('product-images bucket', () => {
  it('is private and only takes small WebP or JPEG files', async () => {
    const { rows } = await pg.query<{ public: boolean; file_size_limit: number; allowed_mime_types: string[] }>(
      `select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'product-images'`
    );
    expect(rows[0]).toEqual({ public: false, file_size_limit: 262144, allowed_mime_types: ['image/webp', 'image/jpeg'] });
  });

  it("lets members upload to their own shop's folder only", async () => {
    for (const member of [owner, manager, staff]) {
      expect(await errorCode(upload(member, imagePath()))).toBeUndefined();
    }
    expect(await errorCode(upload(outsider, imagePath()))).toBe('42501');
    expect(await errorCode(upload(staff, imagePath(otherShop)))).toBe('42501');
    expect(await errorCode(upload(null, imagePath()))).toBe('42501');
  });

  it('refuses paths that are not product picture paths', async () => {
    expect(await errorCode(upload(owner, `${shop}/picture.png`))).toBe('42501');
    expect(await errorCode(upload(owner, `${shop}/../${otherShop}/${'a'.repeat(32)}.webp`))).toBe('42501');
    expect(await errorCode(upload(owner, `${randomBytes(16).toString('hex')}.webp`))).toBe('42501');
  });

  it("hides one shop's pictures from other shops", async () => {
    const path = imagePath();
    await upload(staff, path);
    expect(await visible(manager, path)).toBe(true);
    expect(await visible(staff, path)).toBe(true);
    expect(await visible(outsider, path)).toBe(false);
    expect(await visible(null, path)).toBe(false);
  });

  it('refuses uploads while the shop is suspended', async () => {
    const suspendedOwner = await createUser(pg);
    const suspended = await createShop(pg, suspendedOwner);
    await pg.query(`update public.shops set status = 'suspended', suspended_at = now() where id = $1`, [suspended]);
    expect(await errorCode(upload(suspendedOwner, imagePath(suspended)))).toBe('42501');
  });
});

describe('set_product_image', () => {
  it('lets staff give a new product its first picture, but not replace or remove it', async () => {
    const product = await newProduct(pg, staff, shop);
    const first = imagePath();
    await upload(staff, first);
    const result = await setImage(staff, product.id, first);
    expect(result).toMatchObject({ product: { id: product.id, image_path: first }, previous_path: null });

    const second = imagePath();
    await upload(staff, second);
    expect(await errorCode(setImage(staff, product.id, second))).toBe('42501');
    expect(await errorCode(setImage(staff, product.id, null))).toBe('42501');
    // Sending the same picture again (a retried sync) is fine.
    expect((await setImage(staff, product.id, first)).product.image_path).toBe(first);
  });

  it('lets managers replace and remove pictures, returning the old path for cleanup', async () => {
    const product = await newProduct(pg, owner, shop);
    const first = imagePath();
    const second = imagePath(shop, 'jpg');
    await upload(manager, first);
    await upload(manager, second);
    await setImage(manager, product.id, first);

    const replaced = await setImage(manager, product.id, second);
    expect(replaced).toEqual(expect.objectContaining({ previous_path: first }));
    expect(replaced.product.image_path).toBe(second);

    const removed = await setImage(owner, product.id, null);
    expect(removed).toMatchObject({ product: { image_path: null }, previous_path: second });
  });

  it('keeps a picture another product still uses out of the cleanup', async () => {
    const shared = imagePath();
    await upload(owner, shared);
    const a = await newProduct(pg, owner, shop);
    const b = await newProduct(pg, owner, shop);
    await setImage(owner, a.id, shared);
    await setImage(owner, b.id, shared);
    expect((await setImage(owner, a.id, null)).previous_path).toBeNull();
  });

  it('refuses pictures that were never uploaded or belong to another shop', async () => {
    const product = await newProduct(pg, owner, shop);
    expect(await errorCode(setImage(owner, product.id, imagePath()))).toBe('22023');

    const foreign = imagePath(otherShop);
    await upload(outsider, foreign);
    expect(await errorCode(setImage(owner, product.id, foreign))).toBe('22023');
    expect(await errorCode(setImage(owner, product.id, 'not a path'))).toBe('22023');
  });

  it('refuses outsiders and products from another shop', async () => {
    const product = await newProduct(pg, owner, shop);
    const path = imagePath();
    await upload(owner, path);
    expect(await errorCode(setImage(outsider, product.id, path))).toBe('42501');

    const foreignProduct = await newProduct(pg, outsider, otherShop);
    expect(await errorCode(setImage(owner, foreignProduct.id, path))).toBe('P0002');
  });

  it('cannot be bypassed by writing the column directly', async () => {
    const product = await newProduct(pg, owner, shop);
    const path = imagePath();
    await upload(owner, path);
    expect(
      await errorCode(query(pg, owner, 'update public.products set image_path = $1 where id = $2', [path, product.id]))
    ).toBe('42501');
  });
});

describe('deleting pictures', () => {
  it('lets owners and managers delete pictures no product uses', async () => {
    const path = imagePath();
    await upload(staff, path);
    expect(await remove(staff, path)).toBe(false);
    expect(await remove(outsider, path)).toBe(false);
    expect(await remove(manager, path)).toBe(true);
  });

  it('never deletes a picture a product still points at', async () => {
    const product = await newProduct(pg, owner, shop);
    const path = imagePath();
    await upload(owner, path);
    await setImage(owner, product.id, path);
    expect(await remove(owner, path)).toBe(false);
    expect(await visible(owner, path)).toBe(true);

    await setImage(owner, product.id, null);
    expect(await remove(owner, path)).toBe(true);
  });
});
