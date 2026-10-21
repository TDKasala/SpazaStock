import { PRODUCT_CATEGORIES } from '../components/stock/ProductFormFields';
import type { Product, ProductCategory, ProductStockSummary } from '../types';

/** A stock-page filter that looks at what can still be sold. Null means every product. */
export type StockCondition = 'in' | 'out' | 'low' | 'expiring';

const CONDITION_ORDER: StockCondition[] = ['out', 'low', 'expiring', 'in'];

const CATEGORY_RANK = new Map(PRODUCT_CATEGORIES.map((category, index) => [category, index]));

export function productMatchesQuery(product: Pick<Product, 'name' | 'barcode'>, query: string): boolean {
  const term = query.trim().toLowerCase();
  if (!term) return true;
  return product.name.toLowerCase().includes(term) || product.barcode.toLowerCase().includes(term);
}

export function matchesStockCondition(summary: ProductStockSummary, condition: StockCondition | null): boolean {
  if (!condition) return true;
  const quantity = summary.totalQuantity;
  if (condition === 'in') return quantity > 0;
  if (condition === 'out') return quantity <= 0;
  if (condition === 'low') {
    const minimum = summary.product.minStockUnits;
    return minimum != null && quantity <= minimum;
  }
  return summary.isExpired || summary.isExpiringSoon;
}

export interface CategoryFacet {
  category: ProductCategory;
  count: number;
}

/**
 * Categories present after the search and stock-level filter. The fullest shelves come first.
 * The selected category stays listed even when the other filters leave it empty.
 */
export function categoryFacets(
  summaries: ProductStockSummary[],
  query: string,
  condition: StockCondition | null,
  selected: ProductCategory | null
): CategoryFacet[] {
  const counts = new Map<ProductCategory, number>();
  for (const summary of summaries) {
    if (!productMatchesQuery(summary.product, query)) continue;
    if (!matchesStockCondition(summary, condition)) continue;
    const category = summary.product.category;
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  if (selected && !counts.has(selected)) counts.set(selected, 0);
  return [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || (CATEGORY_RANK.get(a.category) ?? 99) - (CATEGORY_RANK.get(b.category) ?? 99));
}

export interface ConditionFacet {
  condition: StockCondition;
  count: number;
}

/**
 * Stock-level chips that would actually change the list. "In stock" is left out when every
 * remaining product is already in stock. The selected condition stays visible at zero.
 */
export function conditionFacets(
  summaries: ProductStockSummary[],
  query: string,
  category: ProductCategory | null,
  selected: StockCondition | null
): ConditionFacet[] {
  const scoped = summaries.filter(
    (summary) =>
      productMatchesQuery(summary.product, query) && (category === null || summary.product.category === category)
  );
  const counts = new Map<StockCondition, number>(CONDITION_ORDER.map((condition) => [condition, 0]));
  for (const summary of scoped) {
    for (const condition of CONDITION_ORDER) {
      if (matchesStockCondition(summary, condition)) counts.set(condition, (counts.get(condition) ?? 0) + 1);
    }
  }
  return CONDITION_ORDER.filter((condition) => {
    const count = counts.get(condition) ?? 0;
    if (condition === selected) return true;
    if (count === 0) return false;
    if (condition === 'in' && count === scoped.length) return false;
    return true;
  }).map((condition) => ({ condition, count: counts.get(condition) ?? 0 }));
}
