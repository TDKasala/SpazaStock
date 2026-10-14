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
