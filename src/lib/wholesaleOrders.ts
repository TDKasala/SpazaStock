/**
 * What a wholesale draft should offer. Sellable stock is computed by the caller and already
 * excludes expired batches, matching the stock page.
 */

export interface WholesaleSuggestionInput {
  id: string;
  name: string;
  archivedAt?: string | null;
  minStockUnits?: number | null;
  targetStockUnits?: number | null;
  sellable: number;
}

export interface WholesaleSuggestion {
  productId: string;
  name: string;
  sellable: number;
  minimum: number;
  /** Null when the product has no target. The suggested quantity is then zero. */
  target: number | null;
  /** Target minus sellable stock, never below zero. */
  quantity: number;
}

/** Products at or below their minimum. A missing target suggests zero so the merchant can type one. */
export function suggestedOrderLines(products: WholesaleSuggestionInput[]): WholesaleSuggestion[] {
  const lines: WholesaleSuggestion[] = [];
  for (const product of products) {
    if (product.archivedAt) continue;
    const minimum = product.minStockUnits;
    if (minimum == null || product.sellable > minimum) continue;
    const target = product.targetStockUnits ?? null;
    const quantity = target == null ? 0 : Math.max(0, target - product.sellable);
    lines.push({
      productId: product.id,
      name: product.name,
      sellable: product.sellable,
      minimum,
      target,
      quantity,
    });
  }
  lines.sort((a, b) => a.name.localeCompare(b.name));
  return lines;
}
