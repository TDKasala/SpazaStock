export type { Locale } from '../lib/languages';

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
  /** True for the person who created the shop; they can never be removed. */
  isAccountOwner?: boolean;
  /** Suspended shops can be viewed but the server refuses changes until reactivated. */
  status?: ShopStatus;
  /** What the shop's current plan allows, as enforced by the server. */
  entitlements?: ShopEntitlements;
  /** International form, e.g. +27821234567. */
  phone?: string | null;
  address?: string | null;
  city?: string | null;
  /** South African province code, e.g. GP. */
  province?: string | null;
  /** GPS latitude in decimal degrees, when captured at creation. */
  latitude?: number | null;
  /** GPS longitude in decimal degrees, when captured at creation. */
  longitude?: number | null;
  /** True until the owner confirms or skips the common catalogue. Existing shops stay false. */
  catalogPromptPending?: boolean;
}

export type ShopStatus = 'active' | 'suspended';

export interface ShopEntitlements {
  plan: string;
  expiryPush: boolean;
  /** Joined plus invited team members allowed; null is unlimited. */
  teamMaxMembers: number | null;
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
  /** Set when archived: hidden from lists, scans and alerts, but its history is kept. */
  archivedAt?: string | null;
  /**
   * Whether this shop sells the product. False hides it from stock and sales without deleting stock.
   * Omitted on older cached rows, which stay visible.
   */
  listed?: boolean;
  /** Optional brand, e.g. Coca-Cola. */
  brand?: string | null;
  /** Optional size of the single item, e.g. 330ml. */
  size?: string | null;
  /** Shared catalog identity, when this shop product was saved from one. */
  catalogProductId?: string | null;
  /** Path of the product picture in the product-images bucket (`<shopId>/<hash>.webp`). */
  imagePath?: string | null;
  /**
   * Sellable base units at or below which the product is low. Null or omitted means it is not watched.
   */
  minStockUnits?: number | null;
  /**
   * Sellable units to hold after a wholesale order. Null or omitted means no target.
   * When both are set, the target is at least the minimum.
   */
  targetStockUnits?: number | null;
}

export type WholesaleOrderStatus =
  | 'draft'
  | 'approved'
  | 'ordered'
  | 'partially_received'
  | 'received'
  | 'cancelled';

export interface Wholesaler {
  id: string;
  shopId: string;
  name: string;
  phone: string | null;
  note: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WholesaleOrder {
  id: string;
  shopId: string;
  wholesalerId: string | null;
  status: WholesaleOrderStatus;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WholesaleOrderItem {
  id: string;
  shopId: string;
  orderId: string;
  productId: string;
  quantity: number;
  /** Estimated cost per unit. Null means this line has no estimate. */
  estimatedUnitCost?: number | null;
  /** Set when the line is marked purchased. It does not receive stock. */
  purchasedAt?: string | null;
  updatedAt: string;
}

/** Quiets a low-stock alert on every phone until sellable stock rises above the minimum. */
export interface LowStockDismissal {
  id: string;
  shopId: string;
  productId: string;
  dismissedAt: string;
  dismissedBy: string | null;
  /** Set once stock has recovered, so the next drop can alert again. */
  clearedAt: string | null;
  updatedAt: string;
}

export interface ProductRegistrationInput {
  barcode: string;
  name: string;
  category: ProductCategory;
  buyingPrice?: number | null;
  sellingPrice?: number | null;
  brand?: string | null;
  size?: string | null;
}

/**
 * A way a product is bought, e.g. a case of 24. The conversion never changes: a different size is
 * a new packaging and the old one is retired.
 */
export interface ProductPackaging {
  id: string;
  shopId: string;
  productId: string;
  name: string;
  unitsPerPackage: number;
  /** Price for one whole pack. Null: every unit uses the product's selling price. */
  sellingPrice?: number | null;
  createdAt: string;
  updatedAt: string;
  retiredAt: string | null;
}

/** An extra barcode for a product: another single-item code (no packaging) or a pack or case. */
export interface ProductBarcode {
  id: string;
  shopId: string;
  productId: string;
  /** Null: the barcode is on the single item. */
  packagingId: string | null;
  barcode: string;
  createdAt: string;
  updatedAt: string;
  /** Unlinked barcodes are kept as history and no longer match scans. */
  unlinkedAt: string | null;
  unlinkReason: string | null;
}

/** What a scanned barcode means in this shop. */
export interface ResolvedBarcode {
  product: Product;
  /** The pack or case the barcode is on; null for the single item. */
  packaging: ProductPackaging | null;
  /** The alias that matched; null when it is the product's own barcode. */
  barcodeId: string | null;
}

/** Every editable field; an edit always sends the full set, so the last write wins. */
export type ProductEditInput = ProductRegistrationInput;

export interface StockBatch {
  id: string;
  shopId: string;
  productId: string;
  quantity: number;
  initialQuantity: number;
  expiryDate: string | null; // YYYY-MM-DD or null
  costPricePerUnit?: number | null;
  receivedAt: string;
  /** Set when the delivery was counted in packages; quantities above are always in units. */
  packagingId?: string | null;
  packageQuantity?: number | null;
  /** The conversion used when received, kept even if the packaging is retired later. */
  unitsPerPackage?: number | null;
  /** The alias that was scanned to receive it, so a mistaken link can be corrected. */
  receivedBarcodeId?: string | null;
  /** Lot or batch code printed on this delivery. */
  lotNumber?: string | null;
  /** Who this delivery came from. */
  supplierName?: string | null;
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
  /** Units; with a packaging, the number of packages instead. */
  quantity: number;
  expiryDate?: string | null;
  costPricePerUnit?: number | null;
  idempotencyKey?: string;
  /** Counts `quantity` in this packaging's packages. */
  packagingId?: string | null;
  /** The alias that was scanned, recorded on the batch. */
  barcodeId?: string | null;
  lotNumber?: string | null;
  supplierName?: string | null;
  /** Calendar date the delivery arrived. Empty means the time it was saved. */
  receivedAt?: string | null;
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
  /**
   * When set, whole packs of this packaging are charged at its pack price and leftover units
   * at the product price. Ignored when `unitPrice` is given explicitly.
   */
  packagingId?: string | null;
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

export type ExpiryAlertResolution = ExpiryResolutionAction | 'sold_out' | 'superseded' | 'product_archived';

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

/** Where a Smart Product Scan field value came from. */
export type ProductLookupFieldSource = 'verified' | 'external' | 'user' | 'missing';

export interface ProductLookupField<T = string> {
  value: T | null;
  source: ProductLookupFieldSource;
}

/** Normalized suggestion returned by the product-lookup Edge Function (never auto-saved). */
export interface ProductLookupSuggestion {
  name: ProductLookupField;
  brand: ProductLookupField;
  size: ProductLookupField;
  category: ProductLookupField<ProductCategory>;
  barcode: ProductLookupField;
  imageUrl: ProductLookupField;
  /** Set only when the source gave a numeric amount. Never parsed out of the size text. */
  packageQuantity?: number | null;
  packageUnit?: string | null;
  food?: {
    ingredients: ProductLookupField;
    nutriscore: ProductLookupField;
  };
}

export type ProductLookupStatus =
  | 'found'
  | 'not_found'
  | 'unavailable'
  | 'rate_limited'
  | 'invalid_barcode'
  | 'forbidden';

export type ProductLookupMatchSource = 'shop' | 'catalog' | 'cache' | 'open_food_facts';

export type CatalogVerification = 'external' | 'user_submitted' | 'verified';

export type CatalogBarcodeKind = 'unit' | 'alternate' | 'pack';

/** Shared catalog hit returned by product-lookup. Prices and stock are not included. */
export interface CatalogMatch {
  id: string;
  verificationStatus: CatalogVerification;
  kind: CatalogBarcodeKind;
  unitsPerPackage: number | null;
  packageQuantity: number | null;
  packageUnit: string | null;
  unitBarcode: string | null;
  ingredients: string | null;
  imageUrl: string | null;
  /** Shared picture in the product-images bucket (`catalog/<id>.webp`), when one has been published. */
  imagePath?: string | null;
}

/** Payload from `product-lookup`. Soft-fail statuses still let the phone open manual registration. */
export interface ProductLookupResult {
  status: ProductLookupStatus;
  barcode?: string;
  matchSource?: ProductLookupMatchSource;
  suggestion?: ProductLookupSuggestion;
  /** Present when matchSource is `shop` — already in this shop's catalog on the server. */
  shopProduct?: Product;
  /** Present when matchSource is `catalog` — shared identity, not yet this shop's stock. */
  catalog?: CatalogMatch;
}
