import type { SupabaseClient } from '@supabase/supabase-js';
import { getMeta, setMeta } from '../lib/db';
import { emitDataChanged, onDataChanged } from '../lib/events';
import { countOutbox } from './outbox';
import { pullChanges, pushOutbox } from './syncEngine';

export interface SyncStatus {
  enabled: boolean;
  isOnline: boolean;
  isSyncing: boolean;
  pending: number;
  failed: number;
  lastSyncedAt: string | null;
  lastError: string | null;
}

const PERIODIC_SYNC_MS = 60_000;
const LOCAL_CHANGE_DEBOUNCE_MS = 1_500;

function isOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

/** Runs `fn` unless another tab is already syncing. */
async function withSyncLock(fn: () => Promise<void>): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    await navigator.locks.request('spazastock-sync', { ifAvailable: true }, async (lock) => {
      if (lock) await fn();
    });
    return;
  }
  await fn();
}

/**
 * Keeps one shop's outbox flowing to Supabase: syncs on start, when the device comes back
 * online, shortly after local changes, on a timer, and when a backed-off retry falls due.
 */
export class SyncController {
  private status: SyncStatus;
  private listeners = new Set<(status: SyncStatus) => void>();
  private running: Promise<void> | null = null;
  private cleanups: Array<() => void> = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly client: SupabaseClient | null,
    private readonly shopId: string
  ) {
    this.status = {
      enabled: client !== null,
      isOnline: isOnline(),
      isSyncing: false,
      pending: 0,
      failed: 0,
      lastSyncedAt: null,
      lastError: null,
    };
  }

  getStatus(): SyncStatus {
    return this.status;
  }

  subscribe(listener: (status: SyncStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => {
      this.listeners.delete(listener);
    };
  }

  start(): void {
    const handleOnline = () => {
      this.update({ isOnline: true });
      void this.syncNow();
    };
    const handleOffline = () => this.update({ isOnline: false });
    const handleVisible = () => {
      if (document.visibilityState === 'visible') void this.syncNow();
    };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    document.addEventListener('visibilitychange', handleVisible);
    const interval = setInterval(() => void this.syncNow(), PERIODIC_SYNC_MS);
    const unsubscribe = onDataChanged((source) => {
      void this.refreshCounts();
      if (source === 'local') this.schedule(LOCAL_CHANGE_DEBOUNCE_MS);
    });

    this.cleanups.push(
      () => window.removeEventListener('online', handleOnline),
      () => window.removeEventListener('offline', handleOffline),
      () => document.removeEventListener('visibilitychange', handleVisible),
      () => clearInterval(interval),
      unsubscribe
    );

    void getMeta(this.lastSyncKey()).then((value) => {
      if (value) this.update({ lastSyncedAt: value });
    });
    void this.syncNow();
  }

  stop(): void {
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups = [];
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.listeners.clear();
  }

  /** Runs a sync now, or joins the one already in progress. */
  syncNow(): Promise<void> {
    if (!this.running) {
      this.running = this.run().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  async refreshCounts(): Promise<void> {
    const counts = await countOutbox(this.shopId);
    this.update(counts);
  }

  private schedule(delayMs: number): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.syncNow();
    }, delayMs);
  }

  private scheduleRetry(at: number): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.syncNow();
    }, Math.max(0, at - Date.now()));
  }

  private async run(): Promise<void> {
    await this.refreshCounts();
    const client = this.client;
    if (!client || !isOnline()) {
      this.update({ isOnline: isOnline() });
      return;
    }

    this.update({ isSyncing: true, isOnline: true });
    try {
      await withSyncLock(async () => {
        const push = await pushOutbox(client, this.shopId);
        const pulled = await pullChanges(client, this.shopId);
        if (push.pushed > 0 || pulled > 0) emitDataChanged('remote');
        if (push.retryAt !== null) this.scheduleRetry(push.retryAt);

        const counts = await countOutbox(this.shopId);
        const lastError =
          push.retryAt !== null ? 'Some changes could not be sent yet. Retrying automatically.' : null;
        if (counts.pending === 0) {
          const lastSyncedAt = new Date().toISOString();
          await setMeta(this.lastSyncKey(), lastSyncedAt);
          this.update({ lastSyncedAt, lastError });
        } else {
          this.update({ lastError });
        }
      });
    } catch (err) {
      this.update({ lastError: err instanceof Error ? err.message : String(err) });
    } finally {
      this.update({ isSyncing: false });
      await this.refreshCounts();
    }
  }

  private lastSyncKey(): string {
    return `lastSync:${this.shopId}`;
  }

  private update(patch: Partial<SyncStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const listener of this.listeners) listener(this.status);
  }
}
