import type { Product, ProductPackaging } from '../../types';

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** "Case of 24". */
export function packagingLabel(packaging: Pick<ProductPackaging, 'name' | 'unitsPerPackage'>, t: Translate): string {
  return t('packaging.label', { name: packaging.name, count: packaging.unitsPerPackage });
}

/** "Coca-Cola · 330ml", or '' when neither is set. */
export function brandAndSize(product: Pick<Product, 'brand' | 'size'>): string {
  return [product.brand, product.size].filter(Boolean).join(' · ');
}
