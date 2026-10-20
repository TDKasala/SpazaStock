import { getSupabase } from '../lib/supabase';
import type {
  AdminListRow,
  AnalyticsReport,
  AuditFilters,
  AuditPage,
  CatalogProductDetail,
  CatalogSearchPage,
  GrowthBucket,
  GrowthMetric,
  GrowthSeries,
  OperationsHealth,
  PlansReport,
  PlatformOverview,
  TenantDetail,
  TenantFilters,
  TenantPage,
  TenantRow,
  WhoAmI,
} from './types';
import type { PlatformRole } from './permissions';
import type { NewShopInput } from '../lib/shopDetails';
import type { AdminTranslate } from './i18n';

const PRODUCT_IMAGE_BUCKET = 'product-images';

export type AdminErrorKind = 'forbidden' | 'not_found' | 'conflict' | 'invalid' | 'network' | 'unknown';

export class AdminError extends Error {
  readonly kind: AdminErrorKind;
  constructor(kind: AdminErrorKind, message?: string) {
    super(message ?? kind);
    this.kind = kind;
    this.name = 'AdminError';
  }
}

interface PostgrestLikeError {
  code?: string;
  message?: string;
}

export function errorFromPostgrest(error: PostgrestLikeError): AdminError {
  if (error.code === '22023') return new AdminError('invalid', error.message);
  if (error.code === '42501') return new AdminError('forbidden');
  if (!error.code || /fetch|network/i.test(error.message ?? '')) return new AdminError('network');
  return new AdminError('unknown');
}

/** Admin functions answer { ok: false, code } for a refusal, which they have already audited. */
export function unwrapAdminResult<T>(data: unknown): T {
  const body = data as { ok?: unknown; code?: unknown } | null;
  if (body && body.ok === true) return data as T;
  if (body?.code === 'not_found') throw new AdminError('not_found');
  if (body?.code === 'conflict') throw new AdminError('conflict');
  throw new AdminError('forbidden');
}

async function adminRpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const supabase = getSupabase();
  if (!supabase) throw new AdminError('network');
  let result;
  try {
    result = await supabase.rpc(fn, args);
  } catch {
    throw new AdminError('network');
  }
  if (result.error) throw errorFromPostgrest(result.error);
  return unwrapAdminResult<T>(result.data);
}

export function adminErrorMessage(error: unknown, at: AdminTranslate): string {
  const kind = error instanceof AdminError ? error.kind : 'unknown';
  switch (kind) {
    case 'forbidden':
      return at('errors.forbidden');
    case 'not_found':
      return at('errors.notFound');
    case 'conflict':
      return at('errors.conflict');
    case 'invalid':
      return at('errors.invalid', { message: (error as AdminError).message });
    case 'network':
      return at('errors.network');
    default:
      return at('errors.unknown');
  }
}

const iso = (date: Date) => date.toISOString();

export const adminApi = {
  whoami: () => adminRpc<WhoAmI>('admin_whoami'),

  overview: (from: Date, to: Date) =>
    adminRpc<PlatformOverview>('admin_platform_overview', { p_from: iso(from), p_to: iso(to) }),

  growthSeries: (metric: GrowthMetric, from: Date, to: Date, bucket: GrowthBucket) =>
    adminRpc<GrowthSeries>('admin_growth_series', {
      p_metric: metric,
      p_from: iso(from),
      p_to: iso(to),
      p_bucket: bucket,
    }),

  analytics: (from: Date, to: Date) =>
    adminRpc<AnalyticsReport>('admin_analytics', { p_from: iso(from), p_to: iso(to) }),

  listTenants: (filters: TenantFilters, limit: number, offset: number) =>
    adminRpc<TenantPage>('admin_list_tenants', {
      p_search: filters.search || null,
      p_status: filters.status || null,
      p_plan: filters.plan || null,
      p_sort: filters.sort || 'created_desc',
      p_limit: limit,
      p_offset: offset,
    }),

  getTenant: (shopId: string) => adminRpc<TenantDetail>('admin_get_tenant', { p_shop_id: shopId }),

  setShopStatus: (shopId: string, status: 'active' | 'suspended', reason: string) =>
    adminRpc<{ ok: true; unchanged: boolean }>('admin_set_shop_status', {
      p_shop_id: shopId,
      p_status: status,
      p_reason: reason,
    }),

  createShop: (ownerEmail: string, shop: NewShopInput, reason: string) =>
    adminRpc<{ ok: true; shop_id: string }>('admin_create_shop', {
      p_owner_email: ownerEmail,
      p_name: shop.name,
      p_reason: reason,
      p_phone: shop.phone,
      p_address: shop.address,
      p_city: shop.city,
      p_province: shop.province,
      p_latitude: shop.latitude,
      p_longitude: shop.longitude,
    }),

  exportTenants: (filters: TenantFilters, reason: string) =>
    adminRpc<{ ok: true; total: number; truncated: boolean; rows: TenantRow[] }>('admin_export_tenants', {
      p_search: filters.search || null,
      p_status: filters.status || null,
      p_plan: filters.plan || null,
      p_reason: reason,
    }),

  listAdmins: () => adminRpc<{ ok: true; rows: AdminListRow[] }>('admin_list_admins'),

  grantAdmin: (email: string, role: PlatformRole, reason: string) =>
    adminRpc<{ ok: true; unchanged: boolean }>('admin_grant_admin', { p_email: email, p_role: role, p_reason: reason }),

  setAdminRole: (userId: string, role: PlatformRole, reason: string) =>
    adminRpc<{ ok: true; unchanged: boolean }>('admin_set_admin_role', {
      p_user_id: userId,
      p_role: role,
      p_reason: reason,
    }),

  revokeAdmin: (userId: string, reason: string) =>
    adminRpc<{ ok: true }>('admin_revoke_admin', { p_user_id: userId, p_reason: reason }),

  listPlans: () => adminRpc<PlansReport>('admin_list_plans'),

  updateSubscription: (
    shopId: string,
    input: { plan: string; status: string; trialEndsAt: string | null; currentPeriodEnd: string | null },
    reason: string
  ) =>
    adminRpc<{ ok: true; effective_plan: string }>('admin_update_subscription', {
      p_shop_id: shopId,
      p_plan: input.plan,
      p_status: input.status,
      p_trial_ends_at: input.trialEndsAt,
      p_current_period_end: input.currentPeriodEnd,
      p_reason: reason,
    }),

  upsertPlan: (
    plan: {
      code: string;
      name: string;
      priceCents: number | null;
      currency: string;
      billingInterval: 'month' | 'year';
      trialDays: number;
      graceDays: number;
      isActive: boolean;
    },
    reason: string
  ) =>
    adminRpc<{ ok: true; created: boolean }>('admin_upsert_plan', {
      p_code: plan.code,
      p_name: plan.name,
      p_price_cents: plan.priceCents,
      p_currency: plan.currency,
      p_billing_interval: plan.billingInterval,
      p_trial_days: plan.trialDays,
      p_grace_days: plan.graceDays,
      p_is_active: plan.isActive,
      p_reason: reason,
    }),

  setEntitlement: (plan: string, key: string, enabled: boolean, limit: number | null, reason: string) =>
    adminRpc<{ ok: true }>('admin_set_entitlement', {
      p_plan: plan,
      p_key: key,
      p_enabled: enabled,
      p_limit: limit,
      p_reason: reason,
    }),

  setFeature: (key: string, enabled: boolean, reason: string) =>
    adminRpc<{ ok: true }>('admin_set_feature', { p_key: key, p_enabled: enabled, p_reason: reason }),

  operationsHealth: () => adminRpc<OperationsHealth>('admin_operations_health'),

  searchCatalog: (query: string, limit: number, offset: number) =>
    adminRpc<CatalogSearchPage>('admin_search_catalog', {
      p_query: query,
      p_limit: limit,
      p_offset: offset,
    }),

  getCatalogProduct: (id: string) => adminRpc<CatalogProductDetail>('admin_get_catalog_product', { p_id: id }),

  saveCatalogProduct: (
    input: {
      id: string | null;
      name: string;
      brand: string;
      category: string;
      packageSize: string;
      packageQuantity: number | null;
      packageUnit: string;
      verificationStatus: string;
    },
    reason: string
  ) =>
    adminRpc<{ ok: true; created: boolean; id: string }>('admin_save_catalog_product', {
      p_id: input.id,
      p_name: input.name,
      p_brand: input.brand,
      p_category: input.category,
      p_package_size: input.packageSize,
      p_package_quantity: input.packageQuantity,
      p_package_unit: input.packageUnit,
      p_verification_status: input.verificationStatus,
      p_reason: reason,
    }),

  linkCatalogBarcode: (
    catalogId: string,
    barcode: string,
    kind: string,
    unitsPerPackage: number | null,
    reason: string
  ) =>
    adminRpc<{ ok: true; unchanged: boolean }>('admin_link_catalog_barcode', {
      p_catalog_product_id: catalogId,
      p_barcode: barcode,
      p_kind: kind,
      p_units_per_package: unitsPerPackage,
      p_reason: reason,
    }),

  unlinkCatalogBarcode: (barcode: string, reason: string) =>
    adminRpc<{ ok: true }>('admin_unlink_catalog_barcode', { p_barcode: barcode, p_reason: reason }),

  setCatalogImage: (id: string, imagePath: string | null, reason: string) =>
    adminRpc<{ ok: true; image_path: string | null }>('admin_set_catalog_image', {
      p_id: id,
      p_image_path: imagePath,
      p_reason: reason,
    }),

  listAudit: (filters: AuditFilters, limit: number, offset: number) =>
    adminRpc<AuditPage>('admin_list_audit', {
      p_action: filters.action || null,
      p_actor_email: filters.actorEmail || null,
      p_shop_id: filters.shopId || null,
      p_outcome: filters.outcome || null,
      p_from: filters.from ?? null,
      p_to: filters.to ?? null,
      p_limit: limit,
      p_offset: offset,
    }),
};

/** Uploads a compressed picture to `catalog/<id>.webp` (or `.jpg`) and returns that path. */
export async function uploadCatalogImage(
  catalogId: string,
  image: { bytes: ArrayBuffer; mimeType: 'image/webp' | 'image/jpeg' }
): Promise<string> {
  const supabase = getSupabase();
  if (!supabase) throw new AdminError('network');
  const path = `catalog/${catalogId}.${image.mimeType === 'image/jpeg' ? 'jpg' : 'webp'}`;
  const { error } = await supabase.storage.from(PRODUCT_IMAGE_BUCKET).upload(path, image.bytes, {
    contentType: image.mimeType,
    upsert: true,
    cacheControl: '31536000',
  });
  if (error) throw new AdminError('network');
  return path;
}
