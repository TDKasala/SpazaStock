import { describe, it, expect } from 'vitest';
import {
  CACHE_FOUND_TTL_MS,
  CACHE_NOT_FOUND_TTL_MS,
  alternateBarcodesForProduct,
  canonicalizeBarcode,
  cacheExpiresAt,
  classifyOffHttp,
  formValuesFromSuggestion,
  isOffFoundStatus,
  mapOffCategory,
  mapOffProduct,
  mergeCatalogText,
  offProductUrl,
  rateWindowStart,
  sameSellableUnit,
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

describe('Open Food Facts v3', () => {
  it('treats v3 success and v2 status 1 as found, and failure as not found', () => {
    expect(isOffFoundStatus('success')).toBe(true);
    expect(isOffFoundStatus('success_with_warnings')).toBe(true);
    expect(isOffFoundStatus(1)).toBe(true);
    expect(isOffFoundStatus('failure')).toBe(false);
    expect(isOffFoundStatus(0)).toBe(false);
    expect(classifyOffHttp(404)).toBe('not_found');
    expect(classifyOffHttp(429)).toBe('rate_limited');
    expect(classifyOffHttp(503)).toBe('unavailable');
    expect(classifyOffHttp(200)).toBe('ok');
  });

  it('maps a v3 product and leaves optional fields empty when they are absent', () => {
    const suggestion = mapOffProduct(EAN13, {
      status: 'success',
      product: {
        product_name: 'Maize meal',
        product_quantity: '500',
        product_quantity_unit: 'g',
      },
    });
    expect(suggestion?.name).toEqual({ value: 'Maize meal', source: 'external' });
    expect(suggestion?.brand.source).toBe('missing');
    expect(suggestion?.size.source).toBe('missing');
    expect(suggestion?.imageUrl.source).toBe('missing');
    expect(suggestion?.packageQuantity).toBe(500);
    expect(suggestion?.packageUnit).toBe('g');
    expect(suggestion?.food).toBeUndefined();
  });

  it('returns null when a v3 hit has no name', () => {
    expect(mapOffProduct(EAN13, { status: 'success', product: { brands: 'Only brand' } })).toBeNull();
  });

  it('links only another writing of the same GTIN, and not a different quantity', () => {
    expect(alternateBarcodesForProduct(`0${UPCA}`, [UPCA, EAN13], { quantitiesMatch: true })).toEqual([UPCA]);
    expect(alternateBarcodesForProduct(`0${UPCA}`, [UPCA], { quantitiesMatch: false })).toEqual([]);
    expect(
      sameSellableUnit(
        { packageQuantity: 330, packageUnit: 'ml' },
        { packageQuantity: 500, packageUnit: 'ml' }
      )
    ).toBe(false);
    expect(
      sameSellableUnit(
        { packageQuantity: 330, packageUnit: 'ml' },
        { packageQuantity: 330, packageUnit: 'ML' }
      )
    ).toBe(true);
  });

  it('does not replace a verified catalog field with external text', () => {
    expect(mergeCatalogText('Sunlight', 'Sunlight Powder', 'verified', 'external')).toBe('Sunlight');
    expect(mergeCatalogText(null, 'Sunlight', 'external', 'external')).toBe('Sunlight');
    expect(mergeCatalogText('Plain', 'Coke', 'external', 'user_submitted')).toBe('Coke');
  });

  it('calls Open Food Facts v3.6 with a small field list', () => {
    const url = offProductUrl(EAN13);
    expect(url.startsWith(`https://world.openfoodfacts.org/api/v3.6/product/${EAN13}.json`)).toBe(true);
    expect(url).toContain('product_type=all');
    expect(url).toContain('product_name');
    expect(url).not.toContain('knowledge_panels');
  });
});
