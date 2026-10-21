import type { LookupOrigin } from '../components/scanner/ProductRegisterDialog';
import { isArchived, resolveBarcode } from './productService';
import { cacheShopProductLocally, lookupProductByBarcode } from './productLookupService';
import type {
  CatalogMatch,
  Product,
  ProductLookupSuggestion,
  ScanMode,
} from '../types';

/**
 * Where a scanned barcode goes. A shop product, listed or hidden, never opens registration.
 * Only a listed product in stock-in opens the delivery screen.
 */
export type InventoryScan =
  | {
      screen: 'stock_in';
      product: Product;
      packagingId: string | null;
      barcodeId: string | null;
    }
  | { screen: 'found'; product: Product }
  | { screen: 'unknown_stock'; barcode: string }
  | {
      screen: 'register';
      barcode: string;
      mode: ScanMode;
      suggestion: ProductLookupSuggestion | null;
      origin: LookupOrigin;
      catalog: CatalogMatch | null;
    };

export function canReceiveStock(mode: ScanMode, product: Product): boolean {
  return mode === 'stock_in' && !isArchived(product) && product.listed !== false;
}

export async function resolveInventoryScan(barcode: string, shopId: string, mode: ScanMode): Promise<InventoryScan> {
  const resolved = await resolveBarcode(barcode, shopId);
  if (resolved) {
    if (canReceiveStock(mode, resolved.product)) {
      return {
        screen: 'stock_in',
        product: resolved.product,
        packagingId: resolved.barcodeId ? (resolved.packaging?.id ?? null) : null,
        barcodeId: resolved.barcodeId,
      };
    }
    return { screen: 'found', product: resolved.product };
  }

  const lookup = await lookupProductByBarcode(barcode, shopId);
  if (lookup.status === 'found' && lookup.matchSource === 'shop' && lookup.shopProduct) {
    const product = await cacheShopProductLocally(lookup.shopProduct);
    if (canReceiveStock(mode, product)) {
      return { screen: 'stock_in', product, packagingId: null, barcodeId: null };
    }
    return { screen: 'found', product };
  }

  const suggestion = lookup.status === 'found' && lookup.suggestion ? lookup.suggestion : null;
  if (
    suggestion &&
    (lookup.matchSource === 'catalog' || lookup.matchSource === 'open_food_facts' || lookup.matchSource === 'cache')
  ) {
    return {
      screen: 'register',
      barcode,
      mode,
      suggestion,
      origin: lookup.matchSource === 'catalog' ? 'catalog' : 'open_food_facts',
      catalog: lookup.catalog ?? null,
    };
  }

  if (mode === 'stock_in') return { screen: 'unknown_stock', barcode };
  return {
    screen: 'register',
    barcode,
    mode,
    suggestion: null,
    origin: lookup.status === 'not_found' || lookup.status === 'invalid_barcode' ? 'manual' : 'failed',
    catalog: null,
  };
}
