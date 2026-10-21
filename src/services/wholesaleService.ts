import { db, withWriteLock } from '../lib/db';
import { emitDataChanged } from '../lib/events';
import { newId } from '../lib/ids';
import { can } from '../lib/permissions';
import { getShopSettings } from '../lib/shopSettings';
import { enqueue } from '../sync/outbox';
import type { Wholesaler, WholesaleOrder, WholesaleOrderItem, WholesaleOrderStatus } from '../types';

export interface WholesaleOutcome<T> {
  value?: T;
  error?: string;
  errorCode?: 'forbidden' | 'invalid' | 'not_found';
}

const FORBIDDEN: WholesaleOutcome<never> = {
  error: 'Only an owner or manager can change orders.',
  errorCode: 'forbidden',
};

async function canManageOrders(shopId: string): Promise<boolean> {
  return can((await getShopSettings(shopId)).role, 'orders.manage');
}

function cleanName(name: string): string | 'invalid' {
  const trimmed = name.trim();
  return trimmed.length >= 1 && trimmed.length <= 80 ? trimmed : 'invalid';
}

export async function upsertWholesaler(
  shopId: string,
  input: { id?: string; name: string; phone: string; note: string }
): Promise<WholesaleOutcome<Wholesaler>> {
  if (!(await canManageOrders(shopId))) return FORBIDDEN;
  const name = cleanName(input.name);
  if (name === 'invalid') return { error: 'Enter a wholesaler name.', errorCode: 'invalid' };
  const phone = input.phone.trim() || null;
  const note = input.note.trim() || null;
  if (phone && phone.length > 40) return { error: 'Phone is too long.', errorCode: 'invalid' };
  if (note && note.length > 280) return { error: 'Note is too long.', errorCode: 'invalid' };

  const outcome = await withWriteLock(() =>
    db.transaction('rw', db.wholesalers, db.outbox, async (): Promise<WholesaleOutcome<Wholesaler>> => {
      const id = input.id ?? newId();
      const existing = await db.wholesalers.get(id);
      if (existing && existing.shopId !== shopId) return { error: 'Wholesaler not found in this shop.', errorCode: 'not_found' };
      if (existing?.archivedAt) return { error: 'This wholesaler is archived.', errorCode: 'invalid' };
      const now = new Date().toISOString();
      const wholesaler: Wholesaler = {
        id,
        shopId,
        name,
        phone,
        note,
        archivedAt: null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      await db.wholesalers.put(wholesaler);
      await enqueue(shopId, { type: 'wholesaler_upsert', payload: { wholesaler } });
      return { value: wholesaler };
    })
  );
  if (outcome.value) emitDataChanged('local');
  return outcome;
}

export async function archiveWholesaler(shopId: string, wholesalerId: string): Promise<WholesaleOutcome<Wholesaler>> {
  if (!(await canManageOrders(shopId))) return FORBIDDEN;
  const outcome = await withWriteLock(() =>
    db.transaction('rw', db.wholesalers, db.outbox, async (): Promise<WholesaleOutcome<Wholesaler>> => {
      const existing = await db.wholesalers.get(wholesalerId);
      if (!existing || existing.shopId !== shopId) {
        return { error: 'Wholesaler not found in this shop.', errorCode: 'not_found' };
      }
      const wholesaler: Wholesaler = {
        ...existing,
        archivedAt: existing.archivedAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await db.wholesalers.put(wholesaler);
      await enqueue(shopId, { type: 'wholesaler_archive', payload: { wholesalerId } });
      return { value: wholesaler };
    })
  );
  if (outcome.value) emitDataChanged('local');
  return outcome;
}

export async function saveWholesaleOrder(
  shopId: string,
  order: WholesaleOrder,
  items: WholesaleOrderItem[]
): Promise<WholesaleOutcome<{ order: WholesaleOrder; items: WholesaleOrderItem[] }>> {
  if (!(await canManageOrders(shopId))) return FORBIDDEN;
  if (order.shopId !== shopId) return { error: 'Order not found in this shop.', errorCode: 'not_found' };
  if (order.status !== 'draft') return { error: 'Only a draft can be changed.', errorCode: 'invalid' };
  if (items.length > 80) return { error: 'An order can hold up to 80 products.', errorCode: 'invalid' };
  const seen = new Set<string>();
  for (const item of items) {
    if (item.shopId !== shopId || item.orderId !== order.id) {
      return { error: 'Each line must belong to this order.', errorCode: 'invalid' };
    }
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 1_000_000) {
      return { error: 'Quantity must be a whole number from 1 to 1,000,000.', errorCode: 'invalid' };
    }
    const cost = item.estimatedUnitCost ?? null;
    if (cost !== null && (!Number.isFinite(cost) || cost < 0)) {
      return { error: 'Estimated cost cannot be negative.', errorCode: 'invalid' };
    }
    if (seen.has(item.productId)) return { error: 'The same product was sent twice.', errorCode: 'invalid' };
    seen.add(item.productId);
  }

  const outcome = await withWriteLock(() =>
    db.transaction(
      'rw',
      db.wholesaleOrders,
      db.wholesaleOrderItems,
      db.outbox,
      async (): Promise<WholesaleOutcome<{ order: WholesaleOrder; items: WholesaleOrderItem[] }>> => {
        const existing = await db.wholesaleOrders.get(order.id);
        if (existing && existing.shopId !== shopId) return { error: 'Order not found in this shop.', errorCode: 'not_found' };
        if (existing && existing.status !== 'draft') return { error: 'Only a draft can be changed.', errorCode: 'invalid' };
        const now = new Date().toISOString();
        const saved: WholesaleOrder = {
          ...order,
          status: 'draft',
          createdAt: existing?.createdAt ?? order.createdAt ?? now,
          updatedAt: now,
        };
        await db.wholesaleOrders.put(saved);
        await db.wholesaleOrderItems.where('orderId').equals(order.id).delete();
        if (items.length > 0) await db.wholesaleOrderItems.bulkPut(items.map((item) => ({ ...item, updatedAt: now })));
        await enqueue(shopId, { type: 'wholesale_order_save', payload: { order: saved, items } });
        return { value: { order: saved, items } };
      }
    )
  );
  if (outcome.value) emitDataChanged('local');
  return outcome;
}

const TRANSITIONS: Record<WholesaleOrderStatus, WholesaleOrderStatus[]> = {
  draft: ['approved', 'cancelled'],
  approved: ['ordered', 'draft', 'cancelled'],
  ordered: ['partially_received', 'received', 'cancelled'],
  partially_received: ['received', 'cancelled'],
  received: [],
  cancelled: [],
};

export async function setWholesaleOrderStatus(
  shopId: string,
  orderId: string,
  status: WholesaleOrderStatus
): Promise<WholesaleOutcome<WholesaleOrder>> {
  if (!(await canManageOrders(shopId))) return FORBIDDEN;
  const outcome = await withWriteLock(() =>
    db.transaction('rw', db.wholesaleOrders, db.wholesaleOrderItems, db.outbox, async (): Promise<WholesaleOutcome<WholesaleOrder>> => {
      const existing = await db.wholesaleOrders.get(orderId);
      if (!existing || existing.shopId !== shopId) return { error: 'Order not found in this shop.', errorCode: 'not_found' };
      if (existing.status === status) return { value: existing };
      if (!TRANSITIONS[existing.status].includes(status)) {
        return { error: 'That status change is not allowed.', errorCode: 'invalid' };
      }
      if (status !== 'draft' && status !== 'cancelled') {
        const lines = await db.wholesaleOrderItems.where('orderId').equals(orderId).count();
        if (!existing.wholesalerId || lines < 1) {
          return { error: 'Choose a wholesaler and at least one product first.', errorCode: 'invalid' };
        }
      }
      const order: WholesaleOrder = { ...existing, status, updatedAt: new Date().toISOString() };
      await db.wholesaleOrders.put(order);
      await enqueue(shopId, { type: 'wholesale_order_status', payload: { orderId, status } });
      return { value: order };
    })
  );
  if (outcome.value) emitDataChanged('local');
  return outcome;
}

/** Marks one line bought or not. Stock and expiry batches stay as they are. */
export async function setWholesaleItemPurchased(
  shopId: string,
  itemId: string,
  purchased: boolean
): Promise<WholesaleOutcome<WholesaleOrderItem>> {
  if (!(await canManageOrders(shopId))) return FORBIDDEN;
  const outcome = await withWriteLock(() =>
    db.transaction('rw', db.wholesaleOrders, db.wholesaleOrderItems, db.outbox, async (): Promise<WholesaleOutcome<WholesaleOrderItem>> => {
      const existing = await db.wholesaleOrderItems.get(itemId);
      if (!existing || existing.shopId !== shopId) return { error: 'Order line not found in this shop.', errorCode: 'not_found' };
      const order = await db.wholesaleOrders.get(existing.orderId);
      if (!order || order.shopId !== shopId) return { error: 'Order not found in this shop.', errorCode: 'not_found' };
      if (order.status === 'cancelled') return { error: 'A cancelled order cannot be changed.', errorCode: 'invalid' };
      if ((existing.purchasedAt != null) === purchased) return { value: existing };
      const item: WholesaleOrderItem = {
        ...existing,
        purchasedAt: purchased ? new Date().toISOString() : null,
        updatedAt: new Date().toISOString(),
      };
      await db.wholesaleOrderItems.put(item);
      await enqueue(shopId, { type: 'wholesale_item_purchased', payload: { itemId, purchased } });
      return { value: item };
    })
  );
  if (outcome.value) emitDataChanged('local');
  return outcome;
}
