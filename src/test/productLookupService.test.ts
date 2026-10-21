import { describe, it, expect, vi, beforeEach } from 'vitest';
import { productFormFromSuggestion, lookupProductByBarcode } from '../services/productLookupService';
import type { ProductLookupSuggestion } from '../types';

const invoke = vi.fn();

vi.mock('../lib/supabase', () => ({
  getSupabase: () => ({ functions: { invoke } }),
}));

describe('productLookupService', () => {
  beforeEach(() => {
    invoke.mockReset();
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  });

  it('prefills form values from a suggestion without inventing prices', () => {
    const suggestion: ProductLookupSuggestion = {
      name: { value: 'Nesquik', source: 'external' },
      brand: { value: 'Nestlé', source: 'external' },
      size: { value: '500g', source: 'external' },
      category: { value: 'groceries', source: 'external' },
      barcode: { value: '5449000000996', source: 'external' },
      imageUrl: { value: null, source: 'missing' },
    };
    expect(productFormFromSuggestion('5449000000996', suggestion)).toEqual({
      barcode: '5449000000996',
      name: 'Nesquik',
      category: 'groceries',
      buyingPrice: '',
      sellingPrice: '',
      brand: 'Nestlé',
      size: '500g',
    });
  });

  it('soft-fails to unavailable when offline or the function errors', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    expect(await lookupProductByBarcode('5449000000996', 'shop')).toEqual({ status: 'unavailable' });

    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    invoke.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    expect(await lookupProductByBarcode('5449000000996', 'shop')).toEqual({ status: 'unavailable' });

    invoke.mockRejectedValueOnce(new Error('network'));
    expect(await lookupProductByBarcode('5449000000996', 'shop')).toEqual({ status: 'unavailable' });
  });

  it('returns a normalized found payload from the Edge Function', async () => {
    invoke.mockResolvedValueOnce({
      data: {
        status: 'found',
        matchSource: 'open_food_facts',
        barcode: '5449000000996',
        suggestion: {
          name: { value: 'Coke', source: 'external' },
          brand: { value: null, source: 'missing' },
          size: { value: null, source: 'missing' },
          category: { value: 'beverages', source: 'external' },
          barcode: { value: '5449000000996', source: 'external' },
          imageUrl: { value: null, source: 'missing' },
        },
      },
      error: null,
    });
    const result = await lookupProductByBarcode('5449000000996', 'shop');
    expect(result.status).toBe('found');
    expect(result.matchSource).toBe('open_food_facts');
    expect(result.suggestion?.name.value).toBe('Coke');
  });

  it('does not turn a hidden shop product into a sellable one', async () => {
    invoke.mockResolvedValueOnce({
      data: {
        status: 'found',
        matchSource: 'shop',
        barcode: '5449000000996',
        shopProduct: {
          id: 'p1',
          shop_id: 'shop',
          barcode: '5449000000996',
          name: 'Hidden Coke',
          category: 'beverages',
          buying_price: null,
          selling_price: null,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
          archived_at: null,
          listed: false,
          catalog_product_id: 'cat-1',
        },
      },
      error: null,
    });
    const result = await lookupProductByBarcode('5449000000996', 'shop');
    expect(result.status).toBe('found');
    expect(result.shopProduct).toMatchObject({ listed: false, catalogProductId: 'cat-1', name: 'Hidden Coke' });
  });
});
