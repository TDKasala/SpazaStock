import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { Shop, ShopSettings } from '../types';
import { getSupabase } from '../lib/supabase';
import { importLegacyLocalStorage } from '../lib/legacyMigration';
import { DEVICE_SHOP_ID } from '../lib/constants';
import { clearShopData } from '../lib/db';
import { isValidTimezone, normalizeReminderDays } from '../lib/expiry';
import { getShopSettings, sanitizeShopSettings, saveShopSettings } from '../lib/shopSettings';
import { openableShops, pickShop, revokedShops, shopFromRow, signInDenied, type ShopRow } from '../lib/shopList';
import type { NewShopInput } from '../lib/shopDetails';
import { emitDataChanged } from '../lib/events';
import { useAuth } from './AuthContext';

export const DEVICE_SHOP: Shop = { id: DEVICE_SHOP_ID, name: 'My Spaza Shop' };

interface ShopContextValue {
  /** The shop the app is working in. */
  shop: Shop | null;
  /** Every shop the user is an active member of. */
  shops: Shop[];
  /** Time zone, reminder days and role, with defaults filled in. */
  settings: ShopSettings;
  isLoading: boolean;
  error: string | null;
  /** Names of shops whose access ended since the last check; their data has been cleared. */
  revokedShopNames: string[];
  /** Every shop on the account is suspended, so sign-in must stop. */
  accessDenied: boolean;
  dismissRevoked: () => void;
  createShop: (input: NewShopInput) => Promise<{ error?: string }>;
  switchShop: (shopId: string) => void;
  updateAlertSettings: (reminderDays: number[], timezone: string) => Promise<{ error?: string }>;
  /** Clears the new-shop catalogue prompt on this phone after the server accepts confirm or skip. */
  completeCatalogPrompt: () => void;
  reload: () => void;
}

const ShopContext = createContext<ShopContextValue | undefined>(undefined);

function shopsKey(userId: string): string {
  return `spazastock_shops_${userId}`;
}

function selectedKey(userId: string): string {
  return `spazastock_selected_shop_${userId}`;
}

/** Before multi-shop support only one shop was cached, under this key. */
function legacyKey(userId: string): string {
  return `spazastock_shop_${userId}`;
}

function readCachedShops(userId: string): Shop[] {
  try {
    const raw = localStorage.getItem(shopsKey(userId));
    if (raw) return JSON.parse(raw) as Shop[];
    const legacy = localStorage.getItem(legacyKey(userId));
    return legacy ? [JSON.parse(legacy) as Shop] : [];
  } catch {
    return [];
  }
}

function writeCachedShops(userId: string, shops: Shop[]): void {
  localStorage.setItem(shopsKey(userId), JSON.stringify(shops));
  localStorage.removeItem(legacyKey(userId));
}

function readSelectedShopId(userId: string): string | null {
  return localStorage.getItem(selectedKey(userId));
}

/** Lets other screens (e.g. invite acceptance) choose which shop opens next. */
export function rememberSelectedShop(userId: string, shopId: string): void {
  localStorage.setItem(selectedKey(userId), shopId);
}

function settingsOf(shop: Shop | null): ShopSettings {
  return sanitizeShopSettings({ timezone: shop?.timezone, reminderDays: shop?.reminderDays, role: shop?.role });
}

export const ShopProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { mode, user } = useAuth();
  const userId = user?.id ?? null;
  const [shops, setShops] = useState<Shop[]>(mode === 'device' ? [DEVICE_SHOP] : []);
  const [selectedId, setSelectedId] = useState<string | null>(mode === 'device' ? DEVICE_SHOP_ID : null);
  const [isLoading, setIsLoading] = useState(mode === 'cloud');
  const [error, setError] = useState<string | null>(null);
  const [revokedShopNames, setRevokedShopNames] = useState<string[]>([]);
  const [membershipReady, setMembershipReady] = useState(mode !== 'cloud');
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (mode === 'device') {
      setIsLoading(false);
      setMembershipReady(true);
      // Device-only settings live on the phone.
      void getShopSettings(DEVICE_SHOP_ID).then((s) =>
        setShops([{ ...DEVICE_SHOP, timezone: s.timezone, reminderDays: s.reminderDays, role: 'owner', isAccountOwner: true }])
      );
      return;
    }
    const supabase = getSupabase();
    if (!supabase || !userId) {
      setShops([]);
      setIsLoading(false);
      setMembershipReady(true);
      return;
    }

    let active = true;
    const cached = readCachedShops(userId);
    setShops(cached);
    setSelectedId(readSelectedShopId(userId));
    setError(null);
    setMembershipReady(false);

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setIsLoading(false);
      setMembershipReady(true);
      if (cached.length === 0) setError('offline');
      return;
    }

    // A cached list of only suspended shops stays on the loading screen until the server answers,
    // so a shop that was just reactivated is not refused from stale data.
    setIsLoading(cached.length === 0 || signInDenied(cached));
    const load = async () => {
      const { data, error: queryError } = await supabase.rpc('my_shops');
      if (!active) return;
      if (queryError) {
        if (cached.length === 0) setError(queryError.message);
        setMembershipReady(true);
        setIsLoading(false);
        return;
      }

      const fresh = ((data ?? []) as ShopRow[]).map(shopFromRow);
      const revoked = revokedShops(cached, fresh);
      if (revoked.length > 0) {
        // Access has ended (removed or deactivated): unsynced changes can no longer be saved, and
        // the shop's data must not stay readable on this phone.
        await Promise.all(
          revoked.map((s) => clearShopData(s.id).catch((err) => console.warn('Could not clear shop data:', err)))
        );
        if (!active) return;
        setRevokedShopNames((names) => [...names, ...revoked.map((s) => s.name)]);
      }
      writeCachedShops(userId, fresh);
      setShops(fresh);
      setMembershipReady(true);
      setIsLoading(false);
    };
    void load();

    return () => {
      active = false;
    };
  }, [mode, userId, reloadToken]);

  const availableShops = useMemo(() => openableShops(shops), [shops]);
  const shop = useMemo(() => pickShop(availableShops, selectedId), [availableShops, selectedId]);
  const accessDenied = membershipReady && signInDenied(shops);
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

  const switchShop = useCallback(
    (nextId: string) => {
      if (!openableShops(shops).some((s) => s.id === nextId)) return;
      if (userId) rememberSelectedShop(userId, nextId);
      setSelectedId(nextId);
    },
    [shops, userId]
  );

  const createShop = useCallback(
    async (input: NewShopInput) => {
      const supabase = getSupabase();
      const trimmed = input.name.trim();
      if (!supabase || !userId) return { error: 'Not signed in.' };
      if (!trimmed) return { error: 'Shop name is required.' };

      const { data, error: rpcError } = await supabase.rpc('create_shop', {
        p_name: trimmed,
        p_phone: input.phone,
        p_address: input.address,
        p_city: input.city,
        p_province: input.province,
        p_latitude: input.latitude,
        p_longitude: input.longitude,
      });
      if (rpcError || !data) return { error: rpcError?.message ?? 'Could not create shop.' };

      const created = shopFromRow(data as ShopRow);
      const next = [...shops.filter((s) => s.id !== created.id), created];
      writeCachedShops(userId, next);
      rememberSelectedShop(userId, created.id);
      setShops(next);
      setSelectedId(created.id);
      setError(null);
      return {};
    },
    [shops, userId]
  );

  const updateAlertSettings = useCallback(
    async (nextDays: number[], nextTimezone: string) => {
      if (!shop) return { error: 'No shop selected.' };
      const days = normalizeReminderDays(nextDays);
      if (!days) return { error: 'invalid_days' };
      if (!isValidTimezone(nextTimezone)) return { error: 'invalid_timezone' };

      let updated: Shop = { ...shop, timezone: nextTimezone, reminderDays: days };
      if (shop.id !== DEVICE_SHOP_ID) {
        const supabase = getSupabase();
        if (!supabase) return { error: 'Not signed in.' };
        const { data, error: rpcError } = await supabase.rpc('update_shop_alert_settings', {
          p_shop_id: shop.id,
          p_reminder_days: days,
          p_timezone: nextTimezone,
        });
        if (rpcError) return { error: rpcError.message };
        const saved = data as { timezone: string; expiry_reminder_days: number[] };
        updated = { ...shop, timezone: saved.timezone, reminderDays: saved.expiry_reminder_days };
      }

      const next = shops.map((s) => (s.id === updated.id ? updated : s));
      if (userId && shop.id !== DEVICE_SHOP_ID) writeCachedShops(userId, next);
      setShops(next);
      return {};
    },
    [shop, shops, userId]
  );

  const reload = useCallback(() => setReloadToken((n) => n + 1), []);
  const dismissRevoked = useCallback(() => setRevokedShopNames([]), []);
  const completeCatalogPrompt = useCallback(() => {
    if (!userId || !selectedId) return;
    setShops((current) => {
      const next = current.map((item) =>
        item.id === selectedId ? { ...item, catalogPromptPending: false } : item
      );
      writeCachedShops(userId, next);
      return next;
    });
  }, [selectedId, userId]);

  const value = useMemo(
    () => ({
      shop,
      shops: availableShops,
      settings,
      isLoading,
      error,
      revokedShopNames,
      accessDenied,
      dismissRevoked,
      createShop,
      switchShop,
      updateAlertSettings,
      completeCatalogPrompt,
      reload,
    }),
    [
      shop,
      availableShops,
      settings,
      isLoading,
      error,
      revokedShopNames,
      accessDenied,
      dismissRevoked,
      createShop,
      switchShop,
      updateAlertSettings,
      completeCatalogPrompt,
      reload,
    ]
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
