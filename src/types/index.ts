export type Locale = 'en' | 'zu';

export type StockActionType = 'add_stock' | 'quick_sale' | 'expiry_alerts' | 'view_stock';

export type ScanMode = 'lookup' | 'sell' | 'stock_in';

export interface EnvValidationResult {
  isValid: boolean;
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  appName: string;
  errors: string[];
}

export type ProductCategory =
  | 'groceries'
  | 'beverages'
  | 'snacks'
  | 'bakery'
  | 'dairy'
  | 'personal_care'
  | 'household'
  | 'airtime'
  | 'other';

export type ShopRole = 'owner' | 'manager' | 'staff';

export interface Shop {
  id: string;
  name: string;
  /** IANA time zone for calendar decisions such as expiry; the device's zone when unset. */
  timezone?: string;
  /** Days before expiry at which reminders fire. */
  reminderDays?: number[];
  /** The signed-in user's role in this shop. */
  role?: ShopRole;
}

/** Settings the services need offline, cached per shop on the device. */
export interface ShopSettings {
  timezone: string;
  reminderDays: number[];
  role: ShopRole;
}

export interface Product {
  id: string;
  shopId: string;
  barcode: string;
  name: string;
  category: ProductCategory;
  buyingPrice?: number | null;
  sellingPrice?: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProductRegistrationInput {
  barcode: string;
  name: string;
  category: ProductCategory;
  buyingPrice?: number | null;
  sellingPrice?: number | null;
}

export interface StockBatch {
  id: string;
  shopId: string;
  productId: string;
  quantity: number;
  initialQuantity: number;
  expiryDate: string | null; // YYYY-MM-DD or null
  costPricePerUnit?: number | null;
  receivedAt: string;
}

export type StockMovementType =
  | 'stock_in'
  | 'sale'
  | 'adjustment'
  | 'return'
  | 'write_off_expired'
  | 'supplier_return';

export interface StockMovement {
  id: string;
  shopId: string;
  productId: string;
  batchId: string | null;
  saleId?: string | null;
  type: StockMovementType;
  quantityDelta: number;
  resultingTotalQuantity: number;
  idempotencyKey?: string;
  createdAt: string;
}

export interface StockInInput {
  productId: string;
  quantity: number;
  expiryDate?: string | null;
  costPricePerUnit?: number | null;
  idempotencyKey?: string;
}

export interface StockInResult {
  batch: StockBatch;
  movement: StockMovement;
  previousTotalQuantity: number;
  resultingTotalQuantity: number;
}

export interface ProductStockSummary {
  product: Product;
  /** Sellable units: batches that are not past their expiry date. */
  totalQuantity: number;
  /** Units in expired batches, which cannot be sold until resolved. */
  expiredQuantity: number;
  batches: StockBatch[];
  earliestExpiry: string | null;
  isExpired: boolean;
  isExpiringSoon: boolean; // within 7 days
}

export interface BatchAllocation {
  batchId: string;
  quantityDeducted: number;
  batchExpiryDate: string | null;
}

export interface Sale {
  id: string;
  shopId: string;
  productId: string;
  quantity: number;
  unitPrice: number;
  totalAmount: number;
  allocations: BatchAllocation[];
  idempotencyKey: string;
  createdAt: string;
  /** Units later voided (undone); `quantity` and `totalAmount` stay the gross values. */
  voidedQuantity?: number;
}

export interface SaleInput {
  productId: string;
  quantity: number;
  unitPrice?: number | null;
  idempotencyKey?: string;
}

export interface SaleResult {
  sale: Sale;
  product: Product;
  previousTotalStock: number;
  remainingTotalStock: number;
  allocations: BatchAllocation[];
  isQueuedOffline: boolean;
}

export type ExpiryAlertKind = 'reminder' | 'expired';

export type ExpiryResolutionAction = 'discarded' | 'returned_to_supplier' | 'expiry_corrected';

export type ExpiryAlertResolution = ExpiryResolutionAction | 'sold_out' | 'superseded';

/** A server-generated expiry alert (one per batch, expiry date, kind and threshold). */
export interface ExpiryAlert {
  id: string;
  shopId: string;
  batchId: string;
  productId: string;
  kind: ExpiryAlertKind;
  thresholdDays: number | null;
  expiryDate: string;
  quantity: number;
  alertDate: string;
  resolvedAt: string | null;
  resolution: ExpiryAlertResolution | null;
  createdAt: string;
}

export interface StockDiscrepancy {
  id: string;
  shopId: string;
  productId: string;
  saleId: string | null;
  shortfall: number;
  resolvedAt: string | null;
  createdAt: string;
}
