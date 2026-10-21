/**
 * Low-stock rules. Sellable quantity is computed elsewhere (expired batches excluded) and passed in,
 * so this stays free of the database.
 */

export interface LowStockProduct {
  id: string;
  name: string;
  archivedAt?: string | null;
  minStockUnits?: number | null;
}

export interface LowStockDismissalState {
  productId: string;
  clearedAt: string | null;
}

export interface LowStockItem {
  productId: string;
  name: string;
  /** Units that can still be sold. */
  sellable: number;
  /** Units in expired batches. They are not part of `sellable`. */
  expired: number;
  minimum: number;
  /** How many sellable units short of the minimum. Never negative. */
  shortfall: number;
  /** True when a dismissal is still quieting sound for this episode. */
  dismissed: boolean;
}

/**
 * Blank turns the alert off. Anything that is not a whole number of units, including decimals
 * and negatives, is rejected.
 */
export function parseMinStock(text: string): number | null | 'invalid' {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (!/^\d+$/.test(trimmed)) return 'invalid';
  const value = Number(trimmed);
  return Number.isInteger(value) && value >= 0 ? value : 'invalid';
}

/** A dismissal only counts while stock is still at or below the minimum. */
export function dismissalIsActive(
  dismissal: Pick<LowStockDismissalState, 'clearedAt'> | null | undefined,
  sellable: number,
  minimum: number
): boolean {
  if (!dismissal || dismissal.clearedAt) return false;
  return sellable <= minimum;
}

/**
 * Products at or below their minimum. Archived products and products with no minimum are left out.
 * The largest shortfall comes first.
 */
export function lowStockItems(
  products: Array<LowStockProduct & { sellable: number; expired: number }>,
  dismissals: LowStockDismissalState[]
): LowStockItem[] {
  const byProduct = new Map(dismissals.map((row) => [row.productId, row]));
  const items: LowStockItem[] = [];
  for (const product of products) {
    if (product.archivedAt) continue;
    const minimum = product.minStockUnits;
    if (minimum == null) continue;
    if (product.sellable > minimum) continue;
    items.push({
      productId: product.id,
      name: product.name,
      sellable: product.sellable,
      expired: product.expired,
      minimum,
      shortfall: minimum - product.sellable,
      dismissed: dismissalIsActive(byProduct.get(product.id), product.sellable, minimum),
    });
  }
  items.sort((a, b) => b.shortfall - a.shortfall || a.name.localeCompare(b.name));
  return items;
}

/** Product ids whose dismissal should be cleared because sellable stock is above the minimum. */
export function recoveredProductIds(
  products: Array<Pick<LowStockProduct, 'id' | 'minStockUnits' | 'archivedAt'> & { sellable: number }>,
  dismissals: LowStockDismissalState[]
): string[] {
  const byProduct = new Map(products.map((product) => [product.id, product]));
  const ids: string[] = [];
  for (const dismissal of dismissals) {
    if (dismissal.clearedAt) continue;
    const product = byProduct.get(dismissal.productId);
    if (!product || product.archivedAt || product.minStockUnits == null || product.sellable > product.minStockUnits) {
      ids.push(dismissal.productId);
    }
  }
  return ids;
}

export interface OrderListItem {
  name: string;
  shortfall: number;
  size?: string | null;
}

/**
 * WhatsApp text for products that are short of their minimum. Items exactly on the minimum are
 * left out. The largest gap comes first. An empty string means there is nothing to order.
 */
export function orderListText(
  items: OrderListItem[],
  options: { shopName?: string | null; heading: string }
): string {
  const lines = [...items]
    .filter((item) => item.shortfall > 0)
    .sort((a, b) => b.shortfall - a.shortfall || a.name.localeCompare(b.name))
    .map((item) => {
      const size = item.size?.trim();
      const label = size ? `${item.name} ${size}` : item.name;
      return `${label} — ${item.shortfall}`;
    });
  if (lines.length === 0) return '';
  const shopName = options.shopName?.trim();
  return [shopName, options.heading, ...lines].filter(Boolean).join('\n');
}
