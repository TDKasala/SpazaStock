// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import {
  REASON,
  addMember,
  bootstrapSuperadmin,
  createDatabase,
  createUser,
  errorCode,
  query,
  rpc,
  type User,
} from './harness';
import { normalizePhone } from '../../lib/shopDetails';

let pg: PGlite;
let owner: User;
let worker: User;
let outsider: User;
let admin: User;

beforeAll(async () => {
  pg = await createDatabase();
  owner = await createUser(pg);
  worker = await createUser(pg);
  outsider = await createUser(pg);
  admin = await createUser(pg);
  await bootstrapSuperadmin(pg, admin);
}, 60_000);

afterAll(async () => {
  await pg?.close();
});

interface ShopResult {
  id: string;
  name: string;
  phone: string | null;
  address: string | null;
  city: string | null;
  province: string | null;
}

describe('shop contact details', () => {
  it('stores the details given when the shop is created, cleaned up', async () => {
    const shop = await rpc<ShopResult>(pg, owner, 'create_shop', {
      p_name: '  Thandi Spaza ',
      p_phone: '082 123-4567',
      p_address: '  12 Main   Road,\n Soweto ',
      p_city: ' Johannesburg ',
      p_province: 'gp',
    });
    expect(shop).toMatchObject({
      name: 'Thandi Spaza',
      phone: '+27821234567',
      address: '12 Main Road, Soweto',
      city: 'Johannesburg',
      province: 'GP',
    });

    await addMember(pg, owner, shop.id, worker, 'staff');
    const listed = await rpc<ShopResult[]>(pg, worker, 'my_shops');
    expect(listed.find((s) => s.id === shop.id)).toMatchObject({ phone: '+27821234567', province: 'GP' });

    const [row] = await query<ShopResult>(pg, worker, 'select phone, address, city, province from public.shops where id = $1', [shop.id]);
    expect(row).toEqual({ phone: '+27821234567', address: '12 Main Road, Soweto', city: 'Johannesburg', province: 'GP' });
    expect(await query(pg, outsider, 'select phone from public.shops where id = $1', [shop.id])).toEqual([]);
  });

  it('keeps every detail optional, so the name alone still works', async () => {
    const shop = await rpc<ShopResult>(pg, owner, 'create_shop', { p_name: 'Name only' });
    expect(shop).toMatchObject({ phone: null, address: null, city: null, province: null });
    const blank = await rpc<ShopResult>(pg, owner, 'create_shop', {
      p_name: 'Blanks',
      p_phone: '  ',
      p_address: ' ',
      p_city: '',
      p_province: '',
    });
    expect(blank).toMatchObject({ phone: null, address: null, city: null, province: null });
  });

  it('refuses invalid details', async () => {
    const create = (details: Record<string, unknown>) => rpc(pg, owner, 'create_shop', { p_name: 'Bad', ...details });
    expect(await errorCode(create({ p_phone: '12345' }))).toBe('22023');
    expect(await errorCode(create({ p_phone: '082 123 456a' }))).toBe('22023');
    expect(await errorCode(create({ p_address: 'x'.repeat(201) }))).toBe('22023');
    expect(await errorCode(create({ p_city: 'x'.repeat(101) }))).toBe('22023');
    expect(await errorCode(create({ p_province: 'Gauteng' }))).toBe('22023');
  });

  it('cannot be changed directly', async () => {
    const shop = await rpc<ShopResult>(pg, owner, 'create_shop', { p_name: 'Locked', p_phone: '0821234567' });
    expect(await errorCode(query(pg, owner, 'update public.shops set phone = $1 where id = $2', ['+27000000000', shop.id]))).toBe(
      '42501'
    );
  });

  it('normalises phone numbers exactly like the app', async () => {
    const inputs = [
      '0821234567',
      '082 123 4567',
      '(082) 123-4567',
      '27821234567',
      '+27 82 123 4567',
      '0027821234567',
      '+251 91 123 4567',
      '+2521234567',
      '',
      '12345',
      '082123456',
      '+0821234567',
      'phone',
    ];
    for (const input of inputs) {
      const expected = normalizePhone(input);
      let actual: string | null | 'invalid';
      try {
        const { rows } = await pg.query<{ contact: { phone: string | null } }>(
          "select private.shop_contact($1, null, null, null) as contact",
          [input]
        );
        actual = rows[0].contact.phone;
      } catch {
        actual = 'invalid';
      }
      expect(actual, input).toBe(expected);
    }
  });

  it('lets a platform admin set them when creating a shop, and shows them on the tenant page', async () => {
    const created = await rpc<{ ok: boolean; shop_id: string }>(pg, admin, 'admin_create_shop', {
      p_owner_email: owner.email,
      p_name: 'Admin made',
      p_reason: REASON,
      p_phone: '+251 91 123 4567',
      p_address: 'Stand 4410',
      p_city: 'Polokwane',
      p_province: 'LP',
    });
    expect(created.ok).toBe(true);

    const detail = await rpc<{ shop: ShopResult }>(pg, admin, 'admin_get_tenant', { p_shop_id: created.shop_id });
    expect(detail.shop).toMatchObject({
      phone: '+251911234567',
      address: 'Stand 4410',
      city: 'Polokwane',
      province: 'LP',
    });

    expect(
      await errorCode(
        rpc(pg, admin, 'admin_create_shop', {
          p_owner_email: owner.email,
          p_name: 'Bad phone',
          p_reason: REASON,
          p_phone: '123',
        })
      )
    ).toBe('22023');
  });
});
