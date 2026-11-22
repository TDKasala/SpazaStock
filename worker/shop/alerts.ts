/**
 * Scheduled alert generators, ported from private.generate_expiry_alerts and
 * private.generate_low_stock_alerts. Postgres ran them over every shop at once; here the cron
 * Worker calls each shop's object. Notifications go back as effects for D1.
 */
import { one, type SyncSql } from '../db/sql';
import { daysBetween, localDate, zonedTime, type ShopCall } from './context';
import { insert, uuid } from './common';

const later = (a: string, b: string) => (Date.parse(a) >= Date.parse(b) ? a : b);

/** inputs.reminderDays: the shop's reminder thresholds (shops.expiry_reminder_days in D1). */
export function generateExpiryAlerts(call: ShopCall, sql: SyncSql): { inserted: number } {
  const { ctx } = call;
  const now = ctx.now;
  const days = ((call.inputs.reminderDays as number[] | undefined) ?? [21, 14, 7]).map(Number);
  const today = localDate(now, ctx.timezone);

  // Close alerts whose batch sold out or whose expiry date has since changed.
  sql.run(
    `UPDATE expiry_alerts SET resolved_at = ?,
            resolution = CASE WHEN (SELECT quantity FROM stock_batches b WHERE b.id = expiry_alerts.batch_id) <= 0
                              THEN 'sold_out' ELSE 'expiry_corrected' END
      WHERE resolved_at IS NULL AND EXISTS (
        SELECT 1 FROM stock_batches b WHERE b.id = expiry_alerts.batch_id
           AND (b.quantity <= 0 OR b.expiry_date IS NOT expiry_alerts.expiry_date))`,
    now
  );
  // Close alerts whose product has been archived.
  sql.run(
    `UPDATE expiry_alerts SET resolved_at = ?, resolution = 'product_archived'
      WHERE resolved_at IS NULL AND EXISTS (
        SELECT 1 FROM products p WHERE p.id = expiry_alerts.product_id AND p.archived_at IS NOT NULL)`,
    now
  );

  const due = sql.all<{ batch_id: string; product_id: string; name: string; quantity: number; expiry_date: string; received_at: string }>(
    `SELECT b.id AS batch_id, b.product_id, p.name, b.quantity, b.expiry_date, b.received_at
       FROM stock_batches b JOIN products p ON p.id = b.product_id AND p.archived_at IS NULL
      WHERE b.shop_id = ? AND b.quantity > 0 AND b.expiry_date IS NOT NULL
      ORDER BY b.rowid`,
    ctx.shopId
  );

  let inserted = 0;
  for (const b of due) {
    const left = daysBetween(today, b.expiry_date);
    const kind = b.expiry_date < today ? 'expired' : 'reminder';
    const threshold = kind === 'expired' ? null : (days.filter((t) => t >= left).sort((x, y) => x - y)[0] ?? null);
    if (kind === 'reminder' && threshold === null) continue;
    const exists = one(
      sql,
      'SELECT 1 AS x FROM expiry_alerts WHERE batch_id = ? AND expiry_date = ? AND kind = ? AND threshold_days IS ?',
      b.batch_id,
      b.expiry_date,
      kind,
      threshold
    );
    if (exists) continue;
    const alertId = uuid();
    insert(sql, 'expiry_alerts', {
      id: alertId,
      shop_id: ctx.shopId,
      batch_id: b.batch_id,
      product_id: b.product_id,
      kind,
      threshold_days: threshold,
      expiry_date: b.expiry_date,
      quantity: b.quantity,
      alert_date: today,
      created_at: now,
      updated_at: now,
    });
    inserted++;
    sql.run(
      `UPDATE expiry_alerts SET resolved_at = ?, resolution = 'superseded' WHERE batch_id = ? AND id <> ? AND resolved_at IS NULL`,
      now,
      b.batch_id,
      alertId
    );

    const code = b.batch_id.slice(0, 6).toUpperCase();
    const received = localDate(b.received_at, ctx.timezone);
    const daysLeft = daysBetween(today, b.expiry_date);
    const title =
      kind === 'expired'
        ? `Expired: ${b.name}`
        : daysLeft === 0
          ? `Expires today: ${b.name}`
          : daysLeft === 1
            ? `Expires tomorrow: ${b.name}`
            : `Expires in ${daysLeft} days: ${b.name}`;
    call.effects.push({
      kind: 'notify_roles',
      roles: ['owner', 'manager'],
      type: 'expiry',
      title: [...title].slice(0, 200).join(''),
      body: `${b.quantity} units, expiry ${b.expiry_date}, batch ${code} (received ${received}).`,
      data: {
        alert_id: alertId,
        kind,
        threshold_days: threshold,
        days_left: daysLeft,
        batch_id: b.batch_id,
        batch_code: code,
        received_date: received,
        product_id: b.product_id,
        product_name: b.name,
        quantity: b.quantity,
        expiry_date: b.expiry_date,
      },
      // Not before 07:00 shop time, so nobody is woken at night.
      pushAt: later(now, zonedTime(today, '07:00', ctx.timezone)),
    });
  }
  return { inserted };
}

/**
 * private.generate_low_stock_alerts: one alert per low-stock episode, not one per run. Returns the
 * episodes opened (Postgres returned the notification rows, one per owner/manager).
 */
export function generateLowStockAlerts(call: ShopCall, sql: SyncSql): { inserted: number } {
  const { ctx } = call;
  const today = localDate(ctx.now, ctx.timezone);
  const sellable = `coalesce((SELECT sum(b.quantity) FROM stock_batches b
                       WHERE b.shop_id = p.shop_id AND b.product_id = p.id AND b.quantity > 0
                         AND (b.expiry_date IS NULL OR b.expiry_date >= ?)), 0)`;

  sql.run(
    `DELETE FROM low_stock_episodes WHERE NOT EXISTS (
       SELECT 1 FROM products p
        WHERE p.shop_id = low_stock_episodes.shop_id AND p.id = low_stock_episodes.product_id
          AND p.archived_at IS NULL AND p.min_stock_units IS NOT NULL AND ${sellable} <= p.min_stock_units)`,
    today
  );
  const due = sql.all<{ product_id: string; name: string; minimum: number; sellable: number }>(
    `SELECT p.id AS product_id, p.name, p.min_stock_units AS minimum, ${sellable} AS sellable
       FROM products p
      WHERE p.shop_id = ? AND p.archived_at IS NULL AND p.min_stock_units IS NOT NULL
        AND ${sellable} <= p.min_stock_units
        AND NOT EXISTS (SELECT 1 FROM low_stock_episodes e WHERE e.shop_id = p.shop_id AND e.product_id = p.id)
        AND NOT EXISTS (SELECT 1 FROM low_stock_dismissals d WHERE d.shop_id = p.shop_id AND d.product_id = p.id AND d.cleared_at IS NULL)
      ORDER BY p.rowid`,
    today,
    ctx.shopId,
    today
  );
  for (const d of due) {
    insert(sql, 'low_stock_episodes', { shop_id: ctx.shopId, product_id: d.product_id });
    call.effects.push({
      kind: 'notify_roles',
      roles: ['owner', 'manager'],
      type: 'low_stock',
      title: [...`Low stock: ${d.name}`].slice(0, 200).join(''),
      body: `${d.sellable} on hand, minimum ${d.minimum}.`,
      data: { kind: 'low_stock', product_id: d.product_id, product_name: d.name, sellable: d.sellable, minimum: d.minimum },
      pushAt: later(ctx.now, zonedTime(today, '07:00', ctx.timezone)),
    });
  }
  return { inserted: due.length };
}

