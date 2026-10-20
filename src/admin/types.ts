import type { PlatformPermission, PlatformRole } from './permissions';

/** Shapes returned by the admin_* database functions. Counts arrive as JSON numbers. */

export interface WhoAmI {
  ok: true;
  role: PlatformRole | null;
  email: string | null;
  permissions: PlatformPermission[];
}

export type CountMap = Record<string, number>;

export interface PlatformOverview {
  ok: true;
  from: string;
  to: string;
  generated_at: string;
  shops: { total: number; active: number; suspended: number; new: number };
  users: { registered: number; confirmed: number; new: number };
  subscriptions: {
    by_status: CountMap;
    by_plan: CountMap;
    active: number;
    trials_active: number;
    cancellations: number;
  };
  stock: { movements: number; units_in: number; units_out: number; active_shops: number };
  stock_by_reason: CountMap;
  sales: number;
  expiry: { created: number; by_kind: CountMap; resolved: number; by_resolution: CountMap; open: number };
  errors: { push_failed: number; sync_failures: number; cron_failures: number | null };
  revenue: { available: false; reason: string };
}

export type GrowthMetric = 'shops' | 'users' | 'stock_movements' | 'sales' | 'expiry_alerts' | 'active_shops';
export type GrowthBucket = 'day' | 'week' | 'month';

export interface SeriesPoint {
  bucket: string;
  value: number;
}

export interface GrowthSeries {
  ok: true;
  metric: GrowthMetric;
  bucket: GrowthBucket;
  timezone: string;
  series: SeriesPoint[];
}

export interface AnalyticsReport {
  ok: true;
  from: string;
  to: string;
  timezone: string;
  tenants: { at_start: number; at_end: number; new: number };
  usage: { active_shops: number; active_users: number };
  retention: { cohort: string; size: number; active: number[] }[];
  conversion: { trials_started: number; trials_converted: number; trials_lapsed: number };
  plan_distribution: { subscribed: CountMap; effective: CountMap };
  feature_adoption: { shops: number; push_enabled: number; teams: number; expiry_tracking: number };
  stock_volumes: Record<string, { movements: number; units: number }>;
  expiry: { created_by_kind: CountMap; resolved_by_resolution: CountMap; open: number };
}

export type TenantSort = 'created_desc' | 'created_asc' | 'name_asc' | 'activity_desc';

export interface TenantFilters {
  search?: string;
  status?: '' | 'active' | 'suspended';
  plan?: string;
  sort?: TenantSort;
}

export interface TenantRow {
  id: string;
  name: string;
  status: 'active' | 'suspended';
  created_at: string;
  owner_id: string;
  owner_email: string | null;
  owner_name: string | null;
  plan: string | null;
  subscription_status: string | null;
  member_count: number;
  product_count: number;
  last_activity_at: string | null;
}

export interface TenantPage {
  ok: true;
  total: number;
  limit: number;
  offset: number;
  rows: TenantRow[];
}

export interface TenantMember {
  member_id: string;
  user_id: string | null;
  email: string | null;
  display_name: string | null;
  role: string;
  status: string;
  joined_at: string | null;
  last_sign_in_at: string | null;
}

export interface TenantDetail {
  ok: true;
  shop: {
    id: string;
    name: string;
    status: 'active' | 'suspended';
    suspended_at: string | null;
    suspension_reason: string | null;
    suspended_by_email: string | null;
    timezone: string;
    expiry_reminder_days: number[] | null;
    created_at: string;
    phone: string | null;
    address: string | null;
    city: string | null;
    province: string | null;
    latitude: number | null;
    longitude: number | null;
  };
  owner: {
    id: string;
    email: string | null;
    display_name: string | null;
    created_at: string;
    last_sign_in_at: string | null;
    email_confirmed: boolean;
  } | null;
  members: TenantMember[];
  outlets: { id: string; name: string; status: string; created_at: string }[];
  inventory: {
    products: number;
    active_products: number;
    archived_products: number;
    batches_in_stock: number;
    units_in_stock: number;
    stock_value_at_cost: number;
    batches_without_cost: number;
  };
  activity: {
    last_movement_at: string | null;
    movements_30d: number;
    sales_30d: number;
    open_expiry_alerts: number;
    sync_failures_7d: number;
  };
  subscription: {
    plan: string;
    status: string;
    trial_ends_at: string | null;
    current_period_end: string | null;
    provider: string | null;
    created_at: string;
    updated_at: string;
  } | null;
  entitlements: { plan: string; expiry_push: boolean; team_max_members: number | null };
  usage: { team_members: number; team_limit: number | null };
  history: {
    membership: {
      occurred_at: string;
      action: string;
      target_email: string | null;
      actor_email: string | null;
      old_role: string | null;
      new_role: string | null;
    }[];
    subscription: {
      occurred_at: string;
      event: string;
      actor_email: string | null;
      old_plan: string | null;
      new_plan: string | null;
      old_status: string | null;
      new_status: string | null;
    }[];
    admin: { occurred_at: string; action: string; actor_email: string | null; reason: string | null; outcome: string }[];
  };
}

export interface AdminListRow {
  user_id: string;
  email: string;
  display_name: string | null;
  role: PlatformRole;
  status: 'active' | 'revoked';
  granted_at: string;
  granted_by_email: string | null;
  revoked_at: string | null;
  revoked_by_email: string | null;
  last_sign_in_at: string | null;
  is_you: boolean;
}

export interface Plan {
  code: string;
  name: string;
  price_cents: number | null;
  currency: string;
  billing_interval: 'month' | 'year';
  trial_days: number;
  grace_days: number;
  is_active: boolean;
  subscriptions: number;
  entitlements: Record<string, { enabled: boolean; limit: number | null }>;
}

export interface PlansReport {
  ok: true;
  plans: Plan[];
  catalog: { key: string; kind: 'boolean' | 'limit'; description: string }[];
  features: { key: string; enabled: boolean; updated_at: string; updated_by_email: string | null }[];
  payments: { provider_connected: boolean };
}

export interface CronJobHealth {
  job: string;
  schedule: string;
  active: boolean;
  last_run_at: string | null;
  last_status: string | null;
  last_duration_ms: number | null;
  last_success_at: string | null;
  runs_24h: number;
  failures_24h: number;
  last_failure_at: string | null;
  last_failure_message: string | null;
}

export interface OperationsHealth {
  ok: true;
  generated_at: string;
  scheduler: { available: false } | { available: true; jobs: CronJobHealth[] };
  push: {
    by_status_7d: CountMap;
    due_now: number;
    oldest_due_at: string | null;
    failed_24h: number;
    last_sent_at: string | null;
  };
  sync: {
    op_type: string;
    error_code: string;
    occurrences: number;
    shops: number;
    users: number;
    last_seen: string;
  }[];
  integrations: Record<'push_keys' | 'push_subject' | 'scheduler_secret' | 'project_url' | 'payment_provider', boolean>;
}

export interface AuditFilters {
  action?: string;
  actorEmail?: string;
  shopId?: string;
  outcome?: '' | 'success' | 'denied';
  from?: string | null;
  to?: string | null;
}

export interface AuditEntry {
  id: number;
  occurred_at: string;
  actor_id: string | null;
  actor_email: string | null;
  actor_role: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  shop_id: string | null;
  reason: string | null;
  outcome: 'success' | 'denied';
  details: Record<string, unknown> | null;
}

export interface AuditPage {
  ok: true;
  total: number;
  limit: number;
  offset: number;
  rows: AuditEntry[];
}
