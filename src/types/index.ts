export type Locale = 'en' | 'zu';

export type StockActionType = 'add_stock' | 'quick_sale' | 'expiry_alerts' | 'view_stock';

export interface EnvValidationResult {
  isValid: boolean;
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  appName: string;
  errors: string[];
}

export type ConnectionStatus = 'connected' | 'unconfigured' | 'offline';

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
  expiryDate: string | null; // Format YYYY-MM-DD or null
  costPricePerUnit?: number | null;
  receivedAt: string;
}

export type StockMovementType = 'stock_in' | 'sale' | 'adjustment';

export interface StockMovement {
  id: string;
  shopId: string;
  productId: string;
  batchId: string;
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
  totalQuantity: number;
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
  idempotencyKey?: string;
  isOfflineQueued?: boolean;
  createdAt: string;
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

export interface OfflineQueueItem {
  id: string;
  type: 'sale';
  payload: SaleInput;
  shopId: string;
  createdAt: string;
  status: 'pending' | 'syncing' | 'synced' | 'failed';
  error?: string;
}
