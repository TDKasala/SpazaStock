import { db, withWriteLock } from '../lib/db';
import { isValidDateFormat } from '../lib/dates';
import { emitDataChanged } from '../lib/events';
import { newId } from '../lib/ids';
import { can } from '../lib/permissions';
import { getShopSettings } from '../lib/shopSettings';
import { deliveryNeedsExpiry, outstandingQuantity } from '../lib/wholesaleOrders';
import { enqueue } from '../sync/outbox';
import type {
  StockBatch,
  StockMovement,
  Wholesaler,
  WholesaleOrder,
  WholesaleOrderItem,
  WholesaleOrderReceipt,
  WholesaleOrderReceiptLine,
  WholesaleOrderStatus,
} from '../types';

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
  ordered: ['cancelled'],
  partially_received: ['cancelled'],
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

export interface ReceiveLineInput {
  id: string;
  orderItemId: string;
  batchId: string;
  quantity: number;
  expiryDate: string | null;
}

const RECEIVE_FORBIDDEN: WholesaleOutcome<never> = {
  error: 'Only someone who can receive stock can record a delivery.',
  errorCode: 'forbidden',
};

async function canReceiveStock(shopId: string): Promise<boolean> {
  return can((await getShopSettings(shopId)).role, 'stock.receive');
}

/**
 * Records the units that actually arrived. One receipt id is safe to retry.
 * Stock is written here, not through a second stock-in queue item.
 */
export async function receiveWholesaleOrder(
  shopId: string,
  receiptId: string,
  orderId: string,
  lines: ReceiveLineInput[]
): Promise<WholesaleOutcome<{ order: WholesaleOrder; receipt: WholesaleOrderReceipt }>> {
  if (!(await canReceiveStock(shopId))) return RECEIVE_FORBIDDEN;
  if (!receiptId || !orderId || lines.length < 1 || lines.length > 160) {
    return { error: 'Record at least one product.', errorCode: 'invalid' };
  }

  const outcome = await withWriteLock(() =>
    db.transaction(
      'rw',
      [
        db.products,
        db.batches,
        db.movements,
        db.wholesalers,
        db.wholesaleOrders,
        db.wholesaleOrderItems,
        db.wholesaleOrderReceipts,
        db.wholesaleOrderReceiptLines,
        db.outbox,
      ],
      async (): Promise<WholesaleOutcome<{ order: WholesaleOrder; receipt: WholesaleOrderReceipt }>> => {
        const order = await db.wholesaleOrders.get(orderId);
        if (!order || order.shopId !== shopId) return { error: 'Order not found in this shop.', errorCode: 'not_found' };
        const existingReceipt = await db.wholesaleOrderReceipts.get(receiptId);
        if (existingReceipt) {
          if (existingReceipt.shopId !== shopId || existingReceipt.orderId !== orderId) {
            return { error: 'This receipt belongs to another order.', errorCode: 'invalid' };
          }
          return { value: { order, receipt: existingReceipt } };
        }
        if (order.status !== 'ordered' && order.status !== 'partially_received') {
          return { error: 'Only an ordered delivery can be received.', errorCode: 'invalid' };
        }

        const items = await db.wholesaleOrderItems.where('orderId').equals(orderId).toArray();
        const active = items.filter((item) => item.shopId === shopId);
        const receivedByItem = new Map<string, number>();
        const stored = active.length === 0
          ? []
          : await db.wholesaleOrderReceiptLines.where('orderItemId').anyOf(active.map((item) => item.id)).toArray();
        for (const line of stored) {
          receivedByItem.set(line.orderItemId, (receivedByItem.get(line.orderItemId) ?? 0) + line.quantity);
        }
        const asked = new Map<string, number>();
        const seenLine = new Set<string>();
        const seenBatch = new Set<string>();
        for (const line of lines) {
          if (seenLine.has(line.id) || seenBatch.has(line.batchId)) {
            return { error: 'The same delivery line was sent twice.', errorCode: 'invalid' };
          }
          seenLine.add(line.id);
          seenBatch.add(line.batchId);
          if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 1_000_000) {
            return { error: 'Quantity must be a whole number from 1 to 1,000,000.', errorCode: 'invalid' };
          }
          const item = active.find((row) => row.id === line.orderItemId);
          if (!item) return { error: 'Order line not found in this shop.', errorCode: 'not_found' };
          const product = await db.products.get(item.productId);
          if (!product || product.shopId !== shopId) return { error: 'Product not found in this shop.', errorCode: 'not_found' };
          const productBatches = await db.batches.where('productId').equals(item.productId).toArray();
          if (deliveryNeedsExpiry(product.category, productBatches, item.productId)) {
            if (!line.expiryDate || !isValidDateFormat(line.expiryDate)) {
              return { error: 'Enter an expiry date.', errorCode: 'invalid' };
            }
          } else if (line.expiryDate && !isValidDateFormat(line.expiryDate)) {
            return { error: 'Expiry date must be a real date.', errorCode: 'invalid' };
          }
          if (await db.batches.get(line.batchId)) return { error: 'This delivery was already recorded.', errorCode: 'invalid' };
          asked.set(line.orderItemId, (asked.get(line.orderItemId) ?? 0) + line.quantity);
        }
        for (const [itemId, quantity] of asked) {
          const item = active.find((row) => row.id === itemId)!;
          if (quantity > outstandingQuantity(item.quantity, receivedByItem.get(itemId) ?? 0)) {
            return { error: 'That is more than is still outstanding.', errorCode: 'invalid' };
          }
        }

        const now = new Date().toISOString();
        const wholesaler = order.wholesalerId ? await db.wholesalers.get(order.wholesalerId) : undefined;
        const supplierName = wholesaler && wholesaler.shopId === shopId ? wholesaler.name : null;
        const receipt: WholesaleOrderReceipt = {
          id: receiptId,
          shopId,
          orderId,
          receivedAt: now,
          receivedBy: null,
          updatedAt: now,
        };
        const running = new Map<string, number>();
        const receiptLines: WholesaleOrderReceiptLine[] = [];
        for (const line of lines) {
          const item = active.find((row) => row.id === line.orderItemId)!;
          if (!running.has(item.productId)) {
            const rows = await db.batches.where('[shopId+productId]').equals([shopId, item.productId]).toArray();
            running.set(item.productId, rows.reduce((sum, batch) => sum + batch.quantity, 0));
          }
          const nextTotal = (running.get(item.productId) ?? 0) + line.quantity;
          running.set(item.productId, nextTotal);
          const batch: StockBatch = {
            id: line.batchId,
            shopId,
            productId: item.productId,
            quantity: line.quantity,
            initialQuantity: line.quantity,
            expiryDate: line.expiryDate,
            costPricePerUnit: item.estimatedUnitCost ?? null,
            receivedAt: now,
            packagingId: null,
            packageQuantity: null,
            unitsPerPackage: null,
            receivedBarcodeId: null,
            lotNumber: null,
            supplierName,
          };
          const movement: StockMovement = {
            id: newId(),
            shopId,
            productId: item.productId,
            batchId: batch.id,
            type: 'stock_in',
            quantityDelta: line.quantity,
            resultingTotalQuantity: nextTotal,
            idempotencyKey: `stock_in:wholesale:${receiptId}:${line.id}`,
            createdAt: now,
          };
          await db.batches.add(batch);
          await db.movements.add(movement);
          receiptLines.push({
            id: line.id,
            shopId,
            receiptId,
            orderItemId: line.orderItemId,
            batchId: line.batchId,
            quantity: line.quantity,
            expiryDate: line.expiryDate,
            updatedAt: now,
          });
          receivedByItem.set(line.orderItemId, (receivedByItem.get(line.orderItemId) ?? 0) + line.quantity);
        }

        const stillOutstanding = active.some(
          (item) => outstandingQuantity(item.quantity, receivedByItem.get(item.id) ?? 0) > 0
        );
        const saved: WholesaleOrder = {
          ...order,
          status: stillOutstanding ? 'partially_received' : 'received',
          updatedAt: now,
        };
        await db.wholesaleOrders.put(saved);
        await db.wholesaleOrderReceipts.add(receipt);
        await db.wholesaleOrderReceiptLines.bulkAdd(receiptLines);
        await enqueue(shopId, { type: 'wholesale_order_receive', payload: { receiptId, orderId, lines } });
        return { value: { order: saved, receipt } };
      }
    )
  );
  if (outcome.value) emitDataChanged('local');
  return outcome;
}
