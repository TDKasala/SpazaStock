import { db } from '../lib/db';
import type { ExpiryAlertItem } from './stockService';

const MAX_REMEMBERED = 1000;

function metaKey(shopId: string): string {
  return `expiryNotified:${shopId}`;
}

/**
 * Returns the alerts this device has not announced yet and remembers them, atomically, so the
 * sound and vibration play once per alert (batch, expiry date, kind, threshold) even when several
 * refreshes overlap.
 */
export async function takeUnnotifiedAlerts(shopId: string, items: ExpiryAlertItem[]): Promise<ExpiryAlertItem[]> {
  return db.transaction('rw', db.meta, async () => {
    const row = await db.meta.get(metaKey(shopId));
    let seen: string[] = [];
    try {
      seen = row ? (JSON.parse(row.value) as string[]) : [];
    } catch {
      seen = [];
    }
    const known = new Set(seen);
    const fresh = items.filter((item) => !known.has(item.key));
    if (fresh.length > 0) {
      const remembered = [...seen, ...fresh.map((item) => item.key)].slice(-MAX_REMEMBERED);
      await db.meta.put({ key: metaKey(shopId), value: JSON.stringify(remembered) });
    }
    return fresh;
  });
}

function lowStockKey(shopId: string): string {
  return `lowStockNotified:${shopId}`;
}

async function readIds(key: string): Promise<string[]> {
  const row = await db.meta.get(key);
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Product ids that are low and not dismissed, and that this phone has not chimed for yet.
 * Remembered so opening the page again stays quiet.
 */
export async function takeUnnotifiedLowStock(shopId: string, productIds: string[]): Promise<string[]> {
  return db.transaction('rw', db.meta, async () => {
    const seen = await readIds(lowStockKey(shopId));
    const known = new Set(seen);
    const fresh = productIds.filter((id) => !known.has(id));
    if (fresh.length > 0) {
      await db.meta.put({
        key: lowStockKey(shopId),
        value: JSON.stringify([...seen, ...fresh].slice(-MAX_REMEMBERED)),
      });
    }
    return fresh;
  });
}

/** Drops remembered alerts once stock is above the minimum, so the next drop can chime again. */
export async function forgetLowStockEpisodes(shopId: string, productIds: string[]): Promise<void> {
  if (productIds.length === 0) return;
  await db.transaction('rw', db.meta, async () => {
    const drop = new Set(productIds);
    const seen = (await readIds(lowStockKey(shopId))).filter((id) => !drop.has(id));
    await db.meta.put({ key: lowStockKey(shopId), value: JSON.stringify(seen) });
  });
}
