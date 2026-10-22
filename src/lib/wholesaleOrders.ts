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

/** Blank stays blank. Anything else must be zero or more, rounded to cents. */
export function parseEstimatedCost(text: string): number | null | 'invalid' {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return 'invalid';
  return Math.round(value * 100) / 100;
}

/** Quantity times the unit cost, in cents. No cost means the line is left out of the total. */
export function lineTotal(quantity: number, unitCost: number | null): number | null {
  if (unitCost == null) return null;
  return Math.round(quantity * unitCost * 100) / 100;
}

/** Sum of the lines that have a cost. Null when every cost is blank. */
export function orderTotal(lines: Array<{ quantity: number; unitCost: number | null }>): number | null {
  let sum = 0;
  let any = false;
  for (const line of lines) {
    const total = lineTotal(line.quantity, line.unitCost);
    if (total == null) continue;
    any = true;
    sum = Math.round((sum + total) * 100) / 100;
  }
  return any ? sum : null;
}

export function formatRand(amount: number): string {
  return `R ${amount.toFixed(2)}`;
}

export interface OrderSummaryLine {
  name: string;
  quantity: number;
  unitCost: number | null;
  purchased: boolean;
}

/** Plain text for the order screen and the WhatsApp message. */
export function orderSummaryText(
  wholesalerName: string,
  lines: OrderSummaryLine[],
  labels: { purchased: string; total: string }
): string {
  const rows = lines.map((line) => {
    const total = lineTotal(line.quantity, line.unitCost);
    const cost = total == null || line.unitCost == null ? '' : ` × ${formatRand(line.unitCost)} = ${formatRand(total)}`;
    const bought = line.purchased ? ` · ${labels.purchased}` : '';
    return `${line.name} · ${line.quantity}${cost}${bought}`;
  });
  const total = orderTotal(lines.map((line) => ({ quantity: line.quantity, unitCost: line.unitCost })));
  const parts = [wholesalerName, ...rows];
  if (total != null) parts.push(`${labels.total}: ${formatRand(total)}`);
  return parts.join('\n');
}

const EXPIRY_CATEGORIES = new Set(['bakery', 'dairy', 'groceries', 'beverages', 'snacks']);

/** Same products as a normal delivery: a tracked category, or one that already has an expiry batch. */
export function deliveryNeedsExpiry(
  category: string,
  batches: Array<{ productId: string; expiryDate: string | null }>,
  productId: string
): boolean {
  if (EXPIRY_CATEGORIES.has(category)) return true;
  return batches.some((batch) => batch.productId === productId && batch.expiryDate != null);
}

/** Ordered quantity minus every receipt already stored for the line. */
export function outstandingQuantity(ordered: number, received: number): number {
  return Math.max(ordered - received, 0);
}

export interface ShoppingListLine {
  name: string;
  /** Calendar label for the chosen expiry date. Null when no batch was chosen. */
  batchLabel: string | null;
  quantity: number;
  /** Blank stays off the total. Zero is a real price. */
  unitCost: number | null;
}

/**
 * The order for WhatsApp: product, chosen date, quantity, and price.
 * Stock on hand is not included. Callers encode the text for the link.
 */
export function shoppingListText(
  heading: string,
  lines: ShoppingListLine[],
  labels: { line: string; total: string }
): string {
  const rows = lines.map((line) => {
    const parts = [line.name];
    if (line.batchLabel) parts.push(line.batchLabel);
    const amount = lineTotal(line.quantity, line.unitCost);
    if (line.unitCost != null && amount != null) {
      parts.push(
        labels.line
          .replaceAll('{{quantity}}', String(line.quantity))
          .replaceAll('{{each}}', formatRand(line.unitCost))
          .replaceAll('{{amount}}', formatRand(amount))
      );
    } else {
      parts.push(String(line.quantity));
    }
    return parts.join(' · ');
  });
  const parts = [heading, ...rows];
  const sum = orderTotal(lines.map((line) => ({ quantity: line.quantity, unitCost: line.unitCost })));
  if (sum != null) parts.push(`${labels.total}: ${formatRand(sum)}`);
  return parts.join('\n');
}
