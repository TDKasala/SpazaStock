import type { ShopRole, ShopSettings } from '../types';
import { getMeta, setMeta } from './db';
import { can } from './permissions';
import { DEFAULT_REMINDER_DAYS, deviceTimezone, isValidTimezone, normalizeReminderDays } from './expiry';

const ROLES: readonly ShopRole[] = ['owner', 'manager', 'staff'];

function metaKey(shopId: string): string {
  return `shopSettings:${shopId}`;
}

export function defaultShopSettings(): ShopSettings {
  return { timezone: deviceTimezone(), reminderDays: [...DEFAULT_REMINDER_DAYS], role: 'owner' };
}

/** Fills gaps and drops invalid values so callers always get usable settings. */
export function sanitizeShopSettings(value: Partial<ShopSettings> | null | undefined): ShopSettings {
  const defaults = defaultShopSettings();
  return {
    timezone: isValidTimezone(value?.timezone) ? value.timezone : defaults.timezone,
    reminderDays: (value?.reminderDays && normalizeReminderDays(value.reminderDays)) || defaults.reminderDays,
    role: value?.role && ROLES.includes(value.role) ? value.role : defaults.role,
  };
}

/** Settings cached on this device for the shop (works offline). */
export async function getShopSettings(shopId: string): Promise<ShopSettings> {
  const raw = await getMeta(metaKey(shopId));
  if (!raw) return defaultShopSettings();
  try {
    return sanitizeShopSettings(JSON.parse(raw) as Partial<ShopSettings>);
  } catch {
    return defaultShopSettings();
  }
}

export async function saveShopSettings(shopId: string, settings: Partial<ShopSettings>): Promise<ShopSettings> {
  const merged = sanitizeShopSettings({ ...(await getShopSettings(shopId)), ...settings });
  await setMeta(metaKey(shopId), JSON.stringify(merged));
  return merged;
}

export function canManageExpiry(role: ShopRole): boolean {
  return can(role, 'expiry.manage');
}
