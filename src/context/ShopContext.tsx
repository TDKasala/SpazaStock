import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { Shop, ShopRole, ShopSettings } from '../types';
import { getSupabase } from '../lib/supabase';
import { importLegacyLocalStorage } from '../lib/legacyMigration';
import { DEVICE_SHOP_ID } from '../lib/constants';
import { isValidTimezone, normalizeReminderDays } from '../lib/expiry';
import { getShopSettings, sanitizeShopSettings, saveShopSettings } from '../lib/shopSettings';
import { emitDataChanged } from '../lib/events';
import { useAuth } from './AuthContext';

export const DEVICE_SHOP: Shop = { id: DEVICE_SHOP_ID, name: 'My Spaza Shop' };

interface ShopContextValue {
  shop: Shop | null;
  /** Time zone, reminder days and role, with defaults filled in. */
  settings: ShopSettings;
  isLoading: boolean;
  error: string | null;
  createShop: (name: string) => Promise<{ error?: string }>;
  updateAlertSettings: (reminderDays: number[], timezone: string) => Promise<{ error?: string }>;
  reload: () => void;
}

const ShopContext = createContext<ShopContextValue | undefined>(undefined);

function cacheKey(userId: string): string {
  return `spazastock_shop_${userId}`;
}

function readCachedShop(userId: string): Shop | null {
  try {
    const raw = localStorage.getItem(cacheKey(userId));
    return raw ? (JSON.parse(raw) as Shop) : null;
  } catch {
    return null;
  }
}

function settingsOf(shop: Shop | null): ShopSettings {
  return sanitizeShopSettings({ timezone: shop?.timezone, reminderDays: shop?.reminderDays, role: shop?.role });
}

interface ShopRow {
  id: string;
  name: string;
  timezone?: string | null;
  expiry_reminder_days?: number[] | null;
}

function shopFromRow(row: ShopRow, role: ShopRole | undefined): Shop {
  return {
    id: row.id,
    name: row.name,
    timezone: row.timezone ?? undefined,
    reminderDays: row.expiry_reminder_days ?? undefined,
    role,
  };
}

export const ShopProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { mode, user } = useAuth();
  const userId = user?.id ?? null;
  const [shop, setShop] = useState<Shop | null>(mode === 'device' ? DEVICE_SHOP : null);
  const [isLoading, setIsLoading] = useState(mode === 'cloud');
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (mode === 'device') {
      setShop(DEVICE_SHOP);
      setIsLoading(false);
      // Device-only settings live on the phone.
      void getShopSettings(DEVICE_SHOP_ID).then((s) =>
        setShop({ ...DEVICE_SHOP, timezone: s.timezone, reminderDays: s.reminderDays, role: 'owner' })
      );
      return;
    }
    const supabase = getSupabase();
    if (!supabase || !userId) {
      setShop(null);
      setIsLoading(false);
      return;
    }

    let active = true;
    const cached = readCachedShop(userId);
    setShop(cached);
    setError(null);

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setIsLoading(false);
      if (!cached) setError('offline');
      return;
    }

    setIsLoading(!cached);
    const load = async () => {
      // Staff invited by email join their shop here on first sign-in. A failure must not stop
      // the user reaching shops they already belong to.
      const { error: inviteError } = await supabase.rpc('accept_pending_invites');
      if (inviteError) console.warn('Could not accept shop invites:', inviteError.message);

      const { data, error: queryError } = await supabase
        .from('shops')
        .select('id, name, timezone, expiry_reminder_days')
        .order('created_at', { ascending: true })
        .limit(1);
      if (!active) return;
      if (queryError) {
        if (!cached) setError(queryError.message);
      } else if (data && data.length > 0) {
        const row = data[0] as ShopRow;
        const { data: member } = await supabase
          .from('shop_members')
          .select('role')
          .eq('shop_id', row.id)
          .eq('user_id', userId)
          .maybeSingle();
        if (!active) return;
        const next = shopFromRow(row, (member?.role as ShopRole | undefined) ?? cached?.role);
        localStorage.setItem(cacheKey(userId), JSON.stringify(next));
        setShop(next);
      } else {
        localStorage.removeItem(cacheKey(userId));
        setShop(null);
      }
      setIsLoading(false);
    };
    void load();

    return () => {
      active = false;
    };
  }, [mode, userId, reloadToken]);

  const shopId = shop?.id ?? null;
  useEffect(() => {
    if (!shopId) return;
    importLegacyLocalStorage(shopId).catch((err) => console.warn('Legacy data import failed:', err));
  }, [shopId]);

  // Services read these offline (sellable stock, alert rules), so keep the device copy current.
  // Only fields the shop actually carries are written, so a not-yet-loaded shop never overwrites
  // settings cached earlier with defaults.
  const settings = useMemo(() => settingsOf(shop), [shop]);
  const { timezone, reminderDays, role } = shop ?? {};
  useEffect(() => {
    if (!shopId) return;
    const known: Partial<ShopSettings> = {};
    if (timezone) known.timezone = timezone;
    if (reminderDays) known.reminderDays = reminderDays;
    if (role) known.role = role;
    if (Object.keys(known).length === 0) return;
    void saveShopSettings(shopId, known)
      .then(() => emitDataChanged('remote'))
      .catch((err) => console.warn('Could not cache shop settings:', err));
  }, [shopId, timezone, reminderDays, role]);

  const createShop = useCallback(
    async (name: string) => {
      const supabase = getSupabase();
      const trimmed = name.trim();
      if (!supabase || !userId) return { error: 'Not signed in.' };
      if (!trimmed) return { error: 'Shop name is required.' };

      const { data, error: insertError } = await supabase
        .from('shops')
        .insert({ name: trimmed })
        .select('id, name, timezone, expiry_reminder_days')
        .single();
      if (insertError || !data) return { error: insertError?.message ?? 'Could not create shop.' };

      const next = shopFromRow(data as ShopRow, 'owner');
      localStorage.setItem(cacheKey(userId), JSON.stringify(next));
      setShop(next);
      setError(null);
      return {};
    },
    [userId]
  );

  const updateAlertSettings = useCallback(
    async (reminderDays: number[], timezone: string) => {
      if (!shop) return { error: 'No shop selected.' };
      const days = normalizeReminderDays(reminderDays);
      if (!days) return { error: 'invalid_days' };
      if (!isValidTimezone(timezone)) return { error: 'invalid_timezone' };

      if (shop.id !== DEVICE_SHOP_ID) {
        const supabase = getSupabase();
        if (!supabase) return { error: 'Not signed in.' };
        const { data, error: rpcError } = await supabase.rpc('update_shop_alert_settings', {
          p_shop_id: shop.id,
          p_reminder_days: days,
          p_timezone: timezone,
        });
        if (rpcError) return { error: rpcError.message };
        const saved = data as { timezone: string; expiry_reminder_days: number[] };
        const next: Shop = { ...shop, timezone: saved.timezone, reminderDays: saved.expiry_reminder_days };
        if (userId) localStorage.setItem(cacheKey(userId), JSON.stringify(next));
        setShop(next);
        return {};
      }

      setShop({ ...shop, timezone, reminderDays: days });
      return {};
    },
    [shop, userId]
  );

  const reload = useCallback(() => setReloadToken((n) => n + 1), []);

  const value = useMemo(
    () => ({ shop, settings, isLoading, error, createShop, updateAlertSettings, reload }),
    [shop, settings, isLoading, error, createShop, updateAlertSettings, reload]
  );

  return <ShopContext.Provider value={value}>{children}</ShopContext.Provider>;
};

export function useShop(): ShopContextValue {
  const context = useContext(ShopContext);
  if (!context) throw new Error('useShop must be used within a ShopProvider');
  return context;
}

/** Shop ID for components rendered inside the shop gate, where a shop always exists. */
export function useShopId(): string {
  const { shop } = useShop();
  if (!shop) throw new Error('useShopId used before a shop was selected');
  return shop.id;
}
