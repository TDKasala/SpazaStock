import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { getSupabase } from '../lib/supabase';
import { SyncController, type SyncStatus } from '../sync/syncController';
import { retryFailedOutboxItems } from '../sync/outbox';
import { useAuth } from './AuthContext';
import { useShop } from './ShopContext';

interface SyncContextValue {
  status: SyncStatus;
  syncNow: () => Promise<void>;
  retryFailed: () => Promise<void>;
}

const IDLE_STATUS: SyncStatus = {
  enabled: false,
  isOnline: true,
  isSyncing: false,
  pending: 0,
  failed: 0,
  lastSyncedAt: null,
  lastError: null,
};

const SyncContext = createContext<SyncContextValue | undefined>(undefined);

export const SyncProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { mode, user } = useAuth();
  const userId = user?.id ?? null;
  const { shop } = useShop();
  const shopId = shop?.id ?? null;
  const [controller, setController] = useState<SyncController | null>(null);
  const [status, setStatus] = useState<SyncStatus>(IDLE_STATUS);

  useEffect(() => {
    if (!shopId) return;
    const client = mode === 'cloud' && userId ? getSupabase() : null;
    const next = new SyncController(client, shopId);
    const unsubscribe = next.subscribe(setStatus);
    next.start();
    setController(next);
    return () => {
      unsubscribe();
      next.stop();
      setController(null);
    };
  }, [mode, userId, shopId]);

  const syncNow = useCallback(async () => {
    await controller?.syncNow();
  }, [controller]);

  const retryFailed = useCallback(async () => {
    if (!shopId) return;
    await retryFailedOutboxItems(shopId);
    await controller?.syncNow();
  }, [controller, shopId]);

  const value = useMemo(() => ({ status, syncNow, retryFailed }), [status, syncNow, retryFailed]);

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
};

export function useSyncContext(): SyncContextValue {
  const context = useContext(SyncContext);
  if (!context) throw new Error('useSyncStatus must be used within a SyncProvider');
  return context;
}
