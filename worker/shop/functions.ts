/** Every shop-ledger RPC the shop Durable Object serves, by its Postgres function name. */
import type { ApiRow } from '../db/rows';
import type { SyncSql } from '../db/sql';
import type { ShopCall } from './context';
import * as products from './products';
import * as wholesale from './wholesale';
import * as stock from './stock';

export type ShopFunction = (call: ShopCall, sql: SyncSql, args: Record<string, unknown>) => ApiRow | ApiRow[] | null;

export const SHOP_FUNCTIONS: Record<string, ShopFunction> = {
  record_stock_in: stock.recordStockIn,
  add_stock_to_batch: stock.addStockToBatch,
  record_stock_adjustment: stock.recordStockAdjustment,
  record_sale: stock.recordSale,
  void_sale_item: stock.voidSaleItem,
  resolve_expired_batch: stock.resolveExpiredBatch,
  upsert_product: products.upsertProduct,
  update_product: products.updateProduct,
  set_product_archived: products.setProductArchived,
  set_product_listed: products.setProductListed,
  set_product_min_stock: products.setProductMinStock,
  set_product_target_stock: products.setProductTargetStock,
  set_product_image: products.setProductImage,
  create_product_packaging: products.createProductPackaging,
  retire_product_packaging: products.retireProductPackaging,
  set_packaging_price: products.setPackagingPrice,
  link_product_barcode: products.linkProductBarcode,
  unlink_product_barcode: products.unlinkProductBarcode,
  dismiss_low_stock: products.dismissLowStock,
  clear_low_stock_dismissal: products.clearLowStockDismissal,
  upsert_wholesaler: wholesale.upsertWholesaler,
  archive_wholesaler: wholesale.archiveWholesaler,
  save_wholesale_order: wholesale.saveWholesaleOrder,
  set_wholesale_order_status: wholesale.setWholesaleOrderStatus,
  set_wholesale_item_purchased: wholesale.setWholesaleItemPurchased,
  receive_wholesale_order: wholesale.receiveWholesaleOrder,
};
