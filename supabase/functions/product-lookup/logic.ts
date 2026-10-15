/**
 * Pure helpers for the product-lookup Edge Function. No Deno or network APIs here, so Vitest can
 * import this file directly.
 */

export type FieldSource = 'verified' | 'external' | 'user' | 'missing';

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

export interface ProvenanceField<T = string> {
  value: T | null;
  source: FieldSource;
}

export interface FoodInfo {
  ingredients: ProvenanceField;
  nutriscore: ProvenanceField;
}

export interface LookupSuggestion {
  name: ProvenanceField;
  brand: ProvenanceField;
  size: ProvenanceField;
  category: ProvenanceField<ProductCategory>;
  barcode: ProvenanceField;
  imageUrl: ProvenanceField;
  food?: FoodInfo;
}

export type LookupStatus =
  | 'found'
  | 'not_found'
  | 'unavailable'
  | 'rate_limited'
  | 'invalid_barcode'
  | 'forbidden';

export type MatchSource = 'shop' | 'cache' | 'open_food_facts';

export interface ShopProductPayload {
  id: string;
  shopId: string;
  barcode: string;
  name: string;
  category: ProductCategory;
  buyingPrice: number | null;
  sellingPrice: number | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  brand: string | null;
  size: string | null;
  imagePath: string | null;
}

export interface LookupResponse {
  status: LookupStatus;
  barcode?: string;
  matchSource?: MatchSource;
  suggestion?: LookupSuggestion;
  shopProduct?: ShopProductPayload;
}

export const RATE_LIMIT_PER_MINUTE = 30;
export const OFF_TIMEOUT_MS = 4000;
export const CACHE_FOUND_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CACHE_NOT_FOUND_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const OFF_USER_AGENT = 'SpazaStock/1.0 (product-lookup; https://github.com/TDKasala/SpazaStock)';

const DIGITS = /^\d+$/;

/** GS1 mod-10 check for EAN-8, UPC-A, EAN-13 and ITF-14. */
export function hasValidGtinCheckDigit(code: string): boolean {
  if (code.length < 2 || !DIGITS.test(code)) return false;
  let sum = 0;
  for (let i = code.length - 2, weight = 3; i >= 0; i--, weight = weight === 3 ? 1 : 3) {
    sum += Number(code[i]) * weight;
  }
  return (10 - (sum % 10)) % 10 === Number(code[code.length - 1]);
}

/** Expands an 8-digit UPC-E (number system, 6 data digits, check) to its 12-digit UPC-A form. */
export function expandUpcE(code: string): string | null {
  if (!/^[01]\d{7}$/.test(code)) return null;
  const ns = code[0];
  const d = code.slice(1, 7);
  const check = code[7];
  const last = d[5];
  let body: string;
  if (last <= '2') body = `${d[0]}${d[1]}${last}0000${d[2]}${d[3]}${d[4]}`;
  else if (last === '3') body = `${d[0]}${d[1]}${d[2]}00000${d[3]}${d[4]}`;
  else if (last === '4') body = `${d[0]}${d[1]}${d[2]}${d[3]}00000${d[4]}`;
  else body = `${d[0]}${d[1]}${d[2]}${d[3]}${d[4]}0000${last}`;
  return `${ns}${body}${check}`;
}

function field<T>(value: T | null | undefined, source: FieldSource): ProvenanceField<T> {
  if (value == null || (typeof value === 'string' && !value.trim())) {
    return { value: null, source: 'missing' };
  }
  return { value: (typeof value === 'string' ? value.trim() : value) as T, source };
}

/**
 * Canonical cache/OFF key: EAN-13 when the code is UPC-A or UPC-E; EAN-8 and EAN-13 kept as-is.
 * Returns null when the barcode is not a valid EAN/UPC product code.
 */
export function canonicalizeBarcode(raw: string): string | null {
  const code = raw.replace(/\s/g, '');
  if (!code || !DIGITS.test(code)) return null;

  if (code.length === 8) {
    const upcA = expandUpcE(code);
    if (upcA && hasValidGtinCheckDigit(upcA)) return `0${upcA}`;
    if (hasValidGtinCheckDigit(code)) return code; // EAN-8
    return null;
  }
  if (code.length === 12 && hasValidGtinCheckDigit(code)) return `0${code}`;
  if (code.length === 13 && hasValidGtinCheckDigit(code)) return code;
  return null;
}

/** Barcodes to try against the shop catalog (own code + aliases). */
export function shopBarcodeCandidates(raw: string): string[] {
  const trimmed = raw.replace(/\s/g, '');
  const canonical = canonicalizeBarcode(trimmed);
  const out = new Set<string>();
  if (trimmed) out.add(trimmed);
  if (canonical) {
    out.add(canonical);
    if (canonical.length === 13 && canonical.startsWith('0')) out.add(canonical.slice(1));
  }
  return [...out];
}

/** Minute bucket start used by product_lookup_rate. */
export function rateWindowStart(now: Date = new Date()): string {
  const d = new Date(now);
  d.setUTCSeconds(0, 0);
  return d.toISOString();
}

export function cacheExpiresAt(status: 'found' | 'not_found', now: Date = new Date()): string {
  const ms = status === 'found' ? CACHE_FOUND_TTL_MS : CACHE_NOT_FOUND_TTL_MS;
  return new Date(now.getTime() + ms).toISOString();
}

/** Map Open Food Facts category tags / text onto SpazaStock categories. Never returns airtime. */
export function mapOffCategory(tags: string[] | undefined, categoriesText: string | undefined): ProductCategory {
  const haystack = `${(tags ?? []).join(' ')} ${categoriesText ?? ''}`.toLowerCase();
  const has = (...words: string[]) => words.some((w) => haystack.includes(w));

  if (has('beverage', 'drink', 'soda', 'juice', 'water', 'beer', 'wine', 'soft-drink', 'en:beverages')) {
    return 'beverages';
  }
  if (has('snack', 'chip', 'crisp', 'candy', 'chocolate', 'biscuit', 'cookie', 'en:snacks', 'en:sweets')) {
    return 'snacks';
  }
  if (has('bread', 'bakery', 'pastry', 'cake', 'en:breads', 'en:pastries')) return 'bakery';
  if (has('dairy', 'milk', 'cheese', 'yogurt', 'yoghurt', 'butter', 'en:dairies', 'en:milks')) return 'dairy';
  if (has('personal-care', 'shampoo', 'soap', 'toothpaste', 'deodorant', 'cosmetic', 'hygiene')) {
    return 'personal_care';
  }
  if (has('household', 'cleaning', 'detergent', 'laundry', 'disinfectant')) return 'household';
  if (has('grocery', 'food', 'en:foods', 'plant', 'meat', 'cereal', 'pasta', 'rice', 'sauce')) {
    return 'groceries';
  }
  return 'groceries';
}

export interface OffProductJson {
  status?: number;
  product?: {
    product_name?: string;
    product_name_en?: string;
    generic_name?: string;
    brands?: string;
    quantity?: string;
    categories?: string;
    categories_tags?: string[];
    image_url?: string;
    image_front_url?: string;
    ingredients_text?: string;
    ingredients_text_en?: string;
    nutriscore_grade?: string;
  };
}

export function mapOffProduct(barcode: string, body: OffProductJson): LookupSuggestion | null {
  if (body.status !== 1 || !body.product) return null;
  const p = body.product;
  const name = p.product_name?.trim() || p.product_name_en?.trim() || p.generic_name?.trim() || null;
  if (!name) return null;

  const brand = p.brands?.split(',')[0]?.trim() || null;
  const size = p.quantity?.trim() || null;
  const category = mapOffCategory(p.categories_tags, p.categories);
  const imageUrl = p.image_front_url?.trim() || p.image_url?.trim() || null;
  const ingredients = p.ingredients_text_en?.trim() || p.ingredients_text?.trim() || null;
  const nutriscore = p.nutriscore_grade?.trim()?.toUpperCase() || null;

  const suggestion: LookupSuggestion = {
    name: field(name, 'external'),
    brand: field(brand, brand ? 'external' : 'missing'),
    size: field(size, size ? 'external' : 'missing'),
    category: field(category, 'external'),
    barcode: field(barcode, 'external'),
    imageUrl: field(imageUrl, imageUrl ? 'external' : 'missing'),
  };

  if (ingredients || nutriscore) {
    suggestion.food = {
      ingredients: field(ingredients, ingredients ? 'external' : 'missing'),
      nutriscore: field(nutriscore, nutriscore ? 'external' : 'missing'),
    };
  }

  return suggestion;
}

export function suggestionFromShopProduct(product: ShopProductPayload): LookupSuggestion {
  return {
    name: field(product.name, 'verified'),
    brand: field(product.brand, product.brand ? 'verified' : 'missing'),
    size: field(product.size, product.size ? 'verified' : 'missing'),
    category: field(product.category, 'verified'),
    barcode: field(product.barcode, 'verified'),
    imageUrl: { value: null, source: 'missing' },
  };
}

export function mapShopProductRow(row: Record<string, unknown>): ShopProductPayload {
  const num = (v: unknown) => (v == null || v === '' ? null : Number(v));
  const iso = (v: unknown) => (v == null ? null : String(v));
  return {
    id: String(row.id),
    shopId: String(row.shop_id),
    barcode: String(row.barcode),
    name: String(row.name),
    category: row.category as ProductCategory,
    buyingPrice: num(row.buying_price),
    sellingPrice: num(row.selling_price),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    archivedAt: iso(row.archived_at),
    brand: row.brand == null ? null : String(row.brand),
    size: row.size == null ? null : String(row.size),
    imagePath: row.image_path == null ? null : String(row.image_path),
  };
}

/** Prefill values for the register form; leaves prices empty for the user to set. */
export function formValuesFromSuggestion(
  barcode: string,
  suggestion: LookupSuggestion
): {
  barcode: string;
  name: string;
  category: ProductCategory;
  buyingPrice: string;
  sellingPrice: string;
  brand: string;
  size: string;
} {
  return {
    barcode,
    name: suggestion.name.value ?? '',
    category: suggestion.category.value ?? 'groceries',
    buyingPrice: '',
    sellingPrice: '',
    brand: suggestion.brand.value ?? '',
    size: suggestion.size.value ?? '',
  };
}
