import { useEffect, useState } from 'react';
import { useLanguage } from '../context/LanguageContext';
import { DEVICE_SHOP_ID } from '../lib/constants';
import { batchCode } from '../lib/expiry';
import { signalAlert } from '../lib/feedback';
import { showLocalNotification } from '../lib/push';
import { getExpiryAlerts, type ExpiryAlertItem } from '../services/stockService';
import { takeUnnotifiedAlerts } from '../services/alertNotifier';

/** Re-evaluate every minute so a batch crossing midnight (shop time) is flagged without a reload. */
const RECHECK_MS = 60_000;

export interface ExpiryAlertsState {
  alerts: ExpiryAlertItem[];
  isLoading: boolean;
}

/**
 * Current expiry alerts for the shop. Each new alert plays the alert sound and vibration once on
 * this device. In device-only mode there is no server to push, so a backgrounded app also shows a
 * system notification itself.
 */
export function useExpiryAlerts(shopId: string, refreshTrigger: number): ExpiryAlertsState {
  const { t } = useLanguage();
  const [alerts, setAlerts] = useState<ExpiryAlertItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), RECHECK_MS);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const items = await getExpiryAlerts(shopId);
        if (cancelled) return;
        setAlerts(items);
        setIsLoading(false);

        const fresh = await takeUnnotifiedAlerts(shopId, items);
        if (cancelled || fresh.length === 0) return;
        signalAlert();

        if (shopId === DEVICE_SHOP_ID && document.visibilityState === 'hidden') {
          for (const item of fresh) {
            const title =
              item.kind === 'expired'
                ? t('expiry.notifyExpired', { name: item.product.name })
                : item.daysUntilExpiry === 0
                ? t('expiry.notifyToday', { name: item.product.name })
                : t('expiry.notifyReminder', { count: item.daysUntilExpiry, name: item.product.name });
            const body = t('expiry.notifyBody', {
              count: item.batch.quantity,
              date: item.batch.expiryDate ?? '',
              code: batchCode(item.batch.id),
            });
            await showLocalNotification(title, body, `expiry:${item.key}`);
          }
        }
      } catch (err) {
        console.warn('Failed to load expiry alerts:', err);
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // `t` changes identity on every render; the language doesn't affect which alerts exist.
  }, [shopId, refreshTrigger, tick]);

  return { alerts, isLoading };
}
