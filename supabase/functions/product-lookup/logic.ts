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
  /** Numeric amount from the source, only when the source stated one. Never guessed from the size text. */
  packageQuantity?: number | null;
  packageUnit?: string | null;
  /** Other writings of this same GTIN (for example UPC-A beside EAN-13). Not a different product. */
  alternateBarcodes?: string[];
  food?: FoodInfo;
}

export type LookupStatus =
  | 'found'
  | 'not_found'
  | 'unavailable'
  | 'rate_limited'
  | 'invalid_barcode'
  | 'forbidden';

export type MatchSource = 'shop' | 'catalog' | 'cache' | 'open_food_facts';

export type CatalogVerification = 'external' | 'user_submitted' | 'verified';

export type CatalogBarcodeKind = 'unit' | 'alternate' | 'pack';

/** Shared catalog hit. Shop prices and stock are not part of this payload. */
export interface CatalogMatch {
  id: string;
  verificationStatus: CatalogVerification;
  kind: CatalogBarcodeKind;
  unitsPerPackage: number | null;
  packageQuantity: number | null;
  packageUnit: string | null;
  unitBarcode: string | null;
  ingredients: string | null;
  imageUrl: string | null;
}

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
  catalog?: CatalogMatch;
}

export const RATE_LIMIT_PER_MINUTE = 30;
export const OFF_TIMEOUT_MS = 4000;
export const CACHE_FOUND_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CACHE_NOT_FOUND_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const OFF_USER_AGENT = 'SpazaStock/1.0 (landrykasala17@gmail.com)';

/** Fields requested from Open Food Facts v3.6. Knowledge panels and the full record are left out. */
export const OFF_PRODUCT_FIELDS = [
  'code',
  'codes_tags',
  'product_name',
  'product_name_en',
  'generic_name',
  'brands',
  'quantity',
  'product_quantity',
  'product_quantity_unit',
  'categories',
  'categories_tags',
  'image_front_url',
  'image_url',
  'ingredients_text',
  'ingredients_text_en',
].join(',');

export function offProductUrl(barcode: string): string {
  const params = new URLSearchParams({ product_type: 'all', fields: OFF_PRODUCT_FIELDS });
  return `https://world.openfoodfacts.org/api/v3.6/product/${encodeURIComponent(barcode)}.json?${params}`;
}

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
  /** v2 uses 1/0. v3 uses "success", "success_with_warnings" or "failure". */
  status?: number | string;
  product?: {
    product_name?: string;
    product_name_en?: string;
    generic_name?: string;
    brands?: string;
    quantity?: string;
    product_quantity?: string | number;
    product_quantity_unit?: string;
    codes_tags?: string[];
    categories?: string;
    categories_tags?: string[];
    image_url?: string;
    image_front_url?: string;
    ingredients_text?: string;
    ingredients_text_en?: string;
    nutriscore_grade?: string;
  };
}

/** v2 status 1 and v3 success statuses. A failure status or a missing body is not a product. */
export function isOffFoundStatus(status: number | string | undefined): boolean {
  if (status === 1 || status === '1') return true;
  if (typeof status !== 'string') return false;
  const value = status.toLowerCase();
  return value === 'success' || value.startsWith('success_');
}

/** Maps an HTTP result from the product endpoint. A 200 still needs a usable product body. */
export function classifyOffHttp(status: number): 'ok' | 'not_found' | 'rate_limited' | 'unavailable' {
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status < 200 || status >= 300) return 'unavailable';
  return 'ok';
}

function catalogRank(status: CatalogVerification): number {
  if (status === 'verified') return 3;
  if (status === 'user_submitted') return 2;
  return 1;
}

/**
 * Incoming text replaces a stored value only when it is more trusted, or when nothing is stored.
 * A verified or user-submitted value is kept when the incoming source is external.
 */
export function mergeCatalogText(
  stored: string | null,
  incoming: string | null,
  storedStatus: CatalogVerification,
  incomingStatus: CatalogVerification
): string | null {
  const next = incoming?.trim() || null;
  const current = stored?.trim() || null;
  if (!next) return current;
  if (!current) return next;
  if (catalogRank(incomingStatus) > catalogRank(storedStatus)) return next;
  return current;
}

export function sameSellableUnit(
  left: { packageQuantity: number | null; packageUnit: string | null },
  right: { packageQuantity: number | null; packageUnit: string | null }
): boolean {
  if (left.packageQuantity == null || right.packageQuantity == null) return false;
  if (!left.packageUnit || !right.packageUnit) return false;
  return left.packageQuantity === right.packageQuantity && left.packageUnit.toLowerCase() === right.packageUnit.toLowerCase();
}

/**
 * Other barcodes that are the same GTIN written another way (UPC-A next to EAN-13).
 * A different canonical code is a different product and is not linked. A different package
 * quantity is not linked either.
 */
export function alternateBarcodesForProduct(
  primary: string,
  codesTags: string[] | undefined,
  options: { quantitiesMatch: boolean }
): string[] {
  if (!options.quantitiesMatch) return [];
  const canonical = canonicalizeBarcode(primary);
  if (!canonical) return [];
  const out: string[] = [];
  for (const tag of codesTags ?? []) {
    const raw = String(tag).replace(/\s/g, '');
    const code = canonicalizeBarcode(raw);
    if (code !== canonical || raw === canonical) continue;
    if (!out.includes(raw)) out.push(raw);
  }
  return out;
}

function parsePackageQuantity(value: string | number | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return parsed > 0 ? parsed : null;
  }
  return null;
}

export function provenanceForStatus(status: CatalogVerification): FieldSource {
  if (status === 'verified') return 'verified';
  if (status === 'user_submitted') return 'user';
  return 'external';
}

export function mapOffProduct(barcode: string, body: OffProductJson): LookupSuggestion | null {
  if (!isOffFoundStatus(body.status) || !body.product) return null;
  const p = body.product;
  const name = p.product_name?.trim() || p.product_name_en?.trim() || p.generic_name?.trim() || null;
  if (!name) return null;

  const brand = p.brands?.split(',')[0]?.trim() || null;
  const size = p.quantity?.trim() || null;
  const category = mapOffCategory(p.categories_tags, p.categories);
  const imageUrl = p.image_front_url?.trim() || p.image_url?.trim() || null;
  const ingredients = p.ingredients_text_en?.trim() || p.ingredients_text?.trim() || null;
  const nutriscore = p.nutriscore_grade?.trim()?.toUpperCase() || null;
  const packageQuantity = parsePackageQuantity(p.product_quantity);
  const packageUnit = p.product_quantity_unit?.trim() || null;

  const suggestion: LookupSuggestion = {
    name: field(name, 'external'),
    brand: field(brand, brand ? 'external' : 'missing'),
    size: field(size, size ? 'external' : 'missing'),
    category: field(category, 'external'),
    barcode: field(barcode, 'external'),
    imageUrl: field(imageUrl, imageUrl ? 'external' : 'missing'),
    packageQuantity,
    packageUnit,
    alternateBarcodes: alternateBarcodesForProduct(barcode, p.codes_tags, { quantitiesMatch: true }),
  };

  if (ingredients || nutriscore) {
    suggestion.food = {
      ingredients: field(ingredients, ingredients ? 'external' : 'missing'),
      nutriscore: field(nutriscore, nutriscore ? 'external' : 'missing'),
    };
  }

  return suggestion;
}

export function suggestionFromCatalog(input: {
  barcode: string;
  name: string;
  brand: string | null;
  size: string | null;
  category: ProductCategory;
  verificationStatus: CatalogVerification;
  imageUrl: string | null;
  ingredients: string | null;
  packageQuantity: number | null;
  packageUnit: string | null;
}): LookupSuggestion {
  const source = provenanceForStatus(input.verificationStatus);
  const suggestion: LookupSuggestion = {
    name: field(input.name, source),
    brand: field(input.brand, input.brand ? source : 'missing'),
    size: field(input.size, input.size ? source : 'missing'),
    category: field(input.category, source),
    barcode: field(input.barcode, source),
    imageUrl: field(input.imageUrl, input.imageUrl ? source : 'missing'),
    packageQuantity: input.packageQuantity,
    packageUnit: input.packageUnit,
  };
  if (input.ingredients) {
    suggestion.food = {
      ingredients: field(input.ingredients, source),
      nutriscore: { value: null, source: 'missing' },
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
