import type { Shop, ShopRole } from '../types';

/** A row from the my_shops / create_shop functions. */
export interface ShopRow {
  id: string;
  name: string;
  timezone?: string | null;
  expiry_reminder_days?: number[] | null;
  role?: ShopRole | null;
  is_account_owner?: boolean | null;
}

export function shopFromRow(row: ShopRow): Shop {
  return {
    id: row.id,
    name: row.name,
    timezone: row.timezone ?? undefined,
    reminderDays: row.expiry_reminder_days ?? undefined,
    role: row.role ?? undefined,
    isAccountOwner: row.is_account_owner ?? undefined,
  };
}

/** Shops this phone knew about that the server no longer lists: the user's access has ended. */
export function revokedShops(cached: readonly Shop[], fresh: readonly Shop[]): Shop[] {
  const current = new Set(fresh.map((s) => s.id));
  return cached.filter((s) => !current.has(s.id));
}

/** The preferred shop when the user still belongs to it, otherwise their first shop. */
export function pickShop(shops: readonly Shop[], preferredId: string | null): Shop | null {
  return shops.find((s) => s.id === preferredId) ?? shops[0] ?? null;
}
