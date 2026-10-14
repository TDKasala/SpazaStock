import { Product, ProductRegistrationInput } from '../types';
import { getSupabase, isSupabaseConfigured } from '../lib/supabase';

export const DEFAULT_SHOP_ID = 'spaza_active_shop';

const STORAGE_KEY_PREFIX = 'spazastock_products_';

function getStorageKey(shopId: string): string {
  return `${STORAGE_KEY_PREFIX}${shopId}`;
}

export function normalizeBarcode(barcode: string): string {
  return barcode.trim().replace(/[\s\r\n\t]/g, '');
}

const memoryStore = new Map<string, string>();

function getStorageItem(key: string): string | null {
  if (typeof localStorage !== 'undefined') {
    return localStorage.getItem(key);
  }
  return memoryStore.get(key) || null;
}

function setStorageItem(key: string, value: string): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(key, value);
  } else {
    memoryStore.set(key, value);
  }
}

/**
 * Loads products from local shop storage.
 */
function getLocalProducts(shopId: string = DEFAULT_SHOP_ID): Product[] {
  try {
    const raw = getStorageItem(getStorageKey(shopId));
    if (!raw) return [];
    return JSON.parse(raw) as Product[];
  } catch (err) {
    console.error('Error reading local products:', err);
    return [];
  }
}

/**
 * Clears products for a shop (useful for tests or store resets).
 */
export function clearLocalProducts(shopId: string = DEFAULT_SHOP_ID): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem(getStorageKey(shopId));
  }
  memoryStore.delete(getStorageKey(shopId));
}

/**
 * Saves products to local shop storage.
 */
function saveLocalProducts(products: Product[], shopId: string = DEFAULT_SHOP_ID): void {
  try {
    setStorageItem(getStorageKey(shopId), JSON.stringify(products));
  } catch (err) {
    console.error('Error saving local products:', err);
  }
}

/**
 * Searches for a product by barcode in the active shop.
 * Returns null if not found.
 */
export async function searchProductByBarcode(
  barcode: string,
  shopId: string = DEFAULT_SHOP_ID
): Promise<Product | null> {
  const normalized = normalizeBarcode(barcode);
  if (!normalized) return null;

  // Check Supabase if configured
  if (isSupabaseConfigured()) {
    const supabase = getSupabase();
    if (supabase) {
      try {
        const { data, error } = await supabase
          .from('products')
          .select('*')
          .eq('shop_id', shopId)
          .eq('barcode', normalized)
          .maybeSingle();

        if (!error && data) {
          return {
            id: data.id,
            shopId: data.shop_id,
            barcode: data.barcode,
            name: data.name,
            category: data.category,
            buyingPrice: data.buying_price,
            sellingPrice: data.selling_price,
            createdAt: data.created_at,
            updatedAt: data.updated_at,
          };
        }
      } catch (err) {
        console.warn('Supabase query failed, falling back to local catalog:', err);
      }
    }
  }

  // Fallback / local catalog search
  const localItems = getLocalProducts(shopId);
  const found = localItems.find(
    (item) => normalizeBarcode(item.barcode).toLowerCase() === normalized.toLowerCase()
  );
  return found || null;
}

/**
 * Creates a new product in the active shop catalog.
 * Strictly prevents accidental duplicate products with the same barcode.
 */
export async function createProduct(
  input: ProductRegistrationInput,
  shopId: string = DEFAULT_SHOP_ID
): Promise<{ product?: Product; error?: string; isDuplicate?: boolean }> {
  const normalizedBarcode = normalizeBarcode(input.barcode);
  const trimmedName = input.name.trim();

  if (!normalizedBarcode) {
    return { error: 'Barcode is required.' };
  }
  if (!trimmedName) {
    return { error: 'Product name is required.' };
  }

  // Check for duplicate in active shop
  const existing = await searchProductByBarcode(normalizedBarcode, shopId);
  if (existing) {
    return {
      error: `A product with barcode "${normalizedBarcode}" already exists ("${existing.name}").`,
      isDuplicate: true,
      product: existing,
    };
  }

  const now = new Date().toISOString();
  const newProduct: Product = {
    id: `prod_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    shopId,
    barcode: normalizedBarcode,
    name: trimmedName,
    category: input.category,
    buyingPrice: input.buyingPrice ?? null,
    sellingPrice: input.sellingPrice ?? null,
    createdAt: now,
    updatedAt: now,
  };

  // If Supabase is configured, persist to remote
  if (isSupabaseConfigured()) {
    const supabase = getSupabase();
    if (supabase) {
      try {
        const { data, error } = await supabase
          .from('products')
          .insert({
            id: newProduct.id,
            shop_id: shopId,
            barcode: newProduct.barcode,
            name: newProduct.name,
            category: newProduct.category,
            buying_price: newProduct.buyingPrice,
            selling_price: newProduct.sellingPrice,
            created_at: now,
            updated_at: now,
          })
          .select()
          .single();

        if (error) {
          console.warn('Supabase insert returned error, saving locally:', error.message);
        } else if (data) {
          newProduct.id = data.id;
        }
      } catch (err) {
        console.warn('Supabase insert exception, persisting to local catalog:', err);
      }
    }
  }

  // Persist locally for immediate availability and offline readiness
  const current = getLocalProducts(shopId);
  saveLocalProducts([newProduct, ...current], shopId);

  return { product: newProduct };
}

/**
 * Returns all products for the active shop.
 */
export async function getProducts(shopId: string = DEFAULT_SHOP_ID): Promise<Product[]> {
  if (isSupabaseConfigured()) {
    const supabase = getSupabase();
    if (supabase) {
      try {
        const { data, error } = await supabase
          .from('products')
          .select('*')
          .eq('shop_id', shopId)
          .order('created_at', { ascending: false });

        if (!error && data) {
          return data.map((d) => ({
            id: d.id,
            shopId: d.shop_id,
            barcode: d.barcode,
            name: d.name,
            category: d.category,
            buyingPrice: d.buying_price,
            sellingPrice: d.selling_price,
            createdAt: d.created_at,
            updatedAt: d.updated_at,
          }));
        }
      } catch (err) {
        console.warn('Supabase fetch failed, returning local products:', err);
      }
    }
  }

  return getLocalProducts(shopId);
}
