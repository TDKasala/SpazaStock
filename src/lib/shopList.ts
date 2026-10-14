import type { Shop, ShopEntitlements, ShopRole, ShopStatus } from '../types';

/** A row from the my_shops / create_shop functions. */
export interface ShopRow {
  id: string;
  name: string;
  timezone?: string | null;
  expiry_reminder_days?: number[] | null;
  role?: ShopRole | null;
  is_account_owner?: boolean | null;
  status?: ShopStatus | null;
  entitlements?: { plan?: string; expiry_push?: boolean; team_max_members?: number | null } | null;
  phone?: string | null;
  address?: string | null;
  city?: string | null;
  province?: string | null;
}

function entitlementsFromRow(row: ShopRow['entitlements']): ShopEntitlements | undefined {
  if (!row) return undefined;
  return {
    plan: row.plan ?? 'free',
    expiryPush: row.expiry_push ?? true,
    teamMaxMembers: row.team_max_members ?? null,
  };
}

export function shopFromRow(row: ShopRow): Shop {
  return {
    id: row.id,
    name: row.name,
    timezone: row.timezone ?? undefined,
    reminderDays: row.expiry_reminder_days ?? undefined,
    role: row.role ?? undefined,
    isAccountOwner: row.is_account_owner ?? undefined,
    status: row.status ?? undefined,
    entitlements: entitlementsFromRow(row.entitlements),
    phone: row.phone ?? undefined,
    address: row.address ?? undefined,
    city: row.city ?? undefined,
    province: row.province ?? undefined,
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
