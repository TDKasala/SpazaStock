import { describe, it, expect } from 'vitest';
import {
  CACHE_FOUND_TTL_MS,
  CACHE_NOT_FOUND_TTL_MS,
  canonicalizeBarcode,
  cacheExpiresAt,
  formValuesFromSuggestion,
  mapOffCategory,
  mapOffProduct,
  rateWindowStart,
  shopBarcodeCandidates,
  suggestionFromShopProduct,
  type LookupSuggestion,
  type ShopProductPayload,
} from '../../supabase/functions/product-lookup/logic';

/** Real EAN-13 (Coca-Cola ZA) with a valid check digit. */
const EAN13 = '6001224760439';
/** UPC-A that pads to EAN-13 with a leading zero. */
const UPCA = '012345678905';

describe('product-lookup barcode canonicalize', () => {
  it('keeps a valid EAN-13', () => {
    expect(canonicalizeBarcode(EAN13)).toBe(EAN13);
    expect(canonicalizeBarcode(` ${EAN13} `)).toBe(EAN13);
  });

  it('pads a valid UPC-A to EAN-13', () => {
    expect(canonicalizeBarcode(UPCA)).toBe(`0${UPCA}`);
  });

  it('expands UPC-E to EAN-13', () => {
    // 01234565 → UPC-A 012345000065 → EAN-13 0012345000065
    expect(canonicalizeBarcode('01234565')).toBe('0012345000065');
  });

  it('rejects non-GTIN and bad check digits', () => {
    expect(canonicalizeBarcode('ABC123')).toBeNull();
    expect(canonicalizeBarcode('6001224760430')).toBeNull();
    expect(canonicalizeBarcode('')).toBeNull();
  });

  it('lists shop lookup candidates including UPC-A without the leading zero', () => {
    const candidates = shopBarcodeCandidates(UPCA);
    expect(candidates).toContain(UPCA);
    expect(candidates).toContain(`0${UPCA}`);
  });
});

describe('product-lookup category map', () => {
  it('maps OFF tags to SpazaStock categories and never picks airtime', () => {
    expect(mapOffCategory(['en:sodas'], 'Beverages')).toBe('beverages');
    expect(mapOffCategory(['en:chips'], 'Snacks')).toBe('snacks');
    expect(mapOffCategory(['en:breads'], undefined)).toBe('bakery');
    expect(mapOffCategory(['en:milks'], 'Dairy')).toBe('dairy');
    expect(mapOffCategory(['en:cleaning'], 'Household')).toBe('household');
    expect(mapOffCategory(['en:shampoos'], 'Personal care')).toBe('personal_care');
    expect(mapOffCategory(['en:foods'], 'Groceries')).toBe('groceries');
    expect(mapOffCategory(undefined, undefined)).toBe('groceries');
  });
});

describe('product-lookup OFF mapper', () => {
  it('maps a found OFF product with provenance', () => {
    const suggestion = mapOffProduct(EAN13, {
      status: 1,
      product: {
        product_name: 'Sunlight Washing Powder',
        brands: 'Sunlight, Unilever',
        quantity: '500g',
        categories_tags: ['en:cleaning'],
        image_front_url: 'https://example.com/sunlight.jpg',
        ingredients_text_en: 'Surfactants',
        nutriscore_grade: 'c',
      },
    });
    expect(suggestion).toMatchObject({
      name: { value: 'Sunlight Washing Powder', source: 'external' },
      brand: { value: 'Sunlight', source: 'external' },
      size: { value: '500g', source: 'external' },
      category: { value: 'household', source: 'external' },
      barcode: { value: EAN13, source: 'external' },
      imageUrl: { value: 'https://example.com/sunlight.jpg', source: 'external' },
      food: {
        ingredients: { value: 'Surfactants', source: 'external' },
        nutriscore: { value: 'C', source: 'external' },
      },
    });
  });

  it('returns null when OFF has no usable name or status 0', () => {
    expect(mapOffProduct(EAN13, { status: 0 })).toBeNull();
    expect(mapOffProduct(EAN13, { status: 1, product: { brands: 'Only brand' } })).toBeNull();
  });

  it('marks missing optional fields', () => {
    const suggestion = mapOffProduct(EAN13, {
      status: 1,
      product: { product_name: 'Plain Rice', categories_tags: ['en:foods'] },
    });
    expect(suggestion?.brand.source).toBe('missing');
    expect(suggestion?.size.source).toBe('missing');
    expect(suggestion?.imageUrl.source).toBe('missing');
    expect(suggestion?.food).toBeUndefined();
  });
});

describe('product-lookup cache and form helpers', () => {
  it('sets longer TTL for found than not_found', () => {
    const now = new Date('2026-10-15T12:00:00.000Z');
    expect(new Date(cacheExpiresAt('found', now)).getTime() - now.getTime()).toBe(CACHE_FOUND_TTL_MS);
    expect(new Date(cacheExpiresAt('not_found', now)).getTime() - now.getTime()).toBe(CACHE_NOT_FOUND_TTL_MS);
  });

  it('truncates the rate window to the UTC minute', () => {
    expect(rateWindowStart(new Date('2026-10-15T12:34:56.789Z'))).toBe('2026-10-15T12:34:00.000Z');
  });

  it('prefills register form values from a suggestion without inventing prices', () => {
    const suggestion: LookupSuggestion = {
      name: { value: 'Nesquik', source: 'external' },
      brand: { value: 'Nestlé', source: 'external' },
      size: { value: '500g', source: 'external' },
      category: { value: 'groceries', source: 'external' },
      barcode: { value: EAN13, source: 'external' },
      imageUrl: { value: null, source: 'missing' },
    };
    expect(formValuesFromSuggestion(EAN13, suggestion)).toEqual({
      barcode: EAN13,
      name: 'Nesquik',
      category: 'groceries',
      buyingPrice: '',
      sellingPrice: '',
      brand: 'Nestlé',
      size: '500g',
    });
  });

  it('marks shop product fields as verified', () => {
    const product: ShopProductPayload = {
      id: 'p1',
      shopId: 's1',
      barcode: EAN13,
      name: 'Shop Coke',
      category: 'beverages',
      buyingPrice: 5,
      sellingPrice: 10,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      archivedAt: null,
      brand: 'Coca-Cola',
      size: '330ml',
      imagePath: null,
    };
    const suggestion = suggestionFromShopProduct(product);
    expect(suggestion.name).toEqual({ value: 'Shop Coke', source: 'verified' });
    expect(suggestion.brand.source).toBe('verified');
    expect(suggestion.imageUrl.source).toBe('missing');
  });
});
