import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { Shop } from '../types';
import { getSupabase } from '../lib/supabase';
import { importLegacyLocalStorage } from '../lib/legacyMigration';
import { DEVICE_SHOP_ID } from '../lib/constants';
import { useAuth } from './AuthContext';

export const DEVICE_SHOP: Shop = { id: DEVICE_SHOP_ID, name: 'My Spaza Shop' };

interface ShopContextValue {
  shop: Shop | null;
  isLoading: boolean;
  error: string | null;
  createShop: (name: string) => Promise<{ error?: string }>;
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
    supabase
      .from('shops')
      .select('id, name')
      .order('created_at', { ascending: true })
      .limit(1)
      .then(({ data, error: queryError }) => {
        if (!active) return;
        if (queryError) {
          if (!cached) setError(queryError.message);
        } else if (data && data.length > 0) {
          const next: Shop = { id: data[0].id, name: data[0].name };
          localStorage.setItem(cacheKey(userId), JSON.stringify(next));
          setShop(next);
        } else {
          localStorage.removeItem(cacheKey(userId));
          setShop(null);
        }
        setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [mode, userId, reloadToken]);

  const shopId = shop?.id ?? null;
  useEffect(() => {
    if (!shopId) return;
    importLegacyLocalStorage(shopId).catch((err) => console.warn('Legacy data import failed:', err));
  }, [shopId]);

  const createShop = useCallback(
    async (name: string) => {
      const supabase = getSupabase();
      const trimmed = name.trim();
      if (!supabase || !userId) return { error: 'Not signed in.' };
      if (!trimmed) return { error: 'Shop name is required.' };

      const { data, error: insertError } = await supabase
        .from('shops')
        .insert({ name: trimmed })
        .select('id, name')
        .single();
      if (insertError || !data) return { error: insertError?.message ?? 'Could not create shop.' };

      const next: Shop = { id: data.id, name: data.name };
      localStorage.setItem(cacheKey(userId), JSON.stringify(next));
      setShop(next);
      setError(null);
      return {};
    },
    [userId]
  );

  const reload = useCallback(() => setReloadToken((n) => n + 1), []);

  const value = useMemo(
    () => ({ shop, isLoading, error, createShop, reload }),
    [shop, isLoading, error, createShop, reload]
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
