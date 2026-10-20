export type PlatformRole = 'superadmin' | 'support' | 'billing' | 'analyst';

export type PlatformPermission =
  | 'admins.manage'
  | 'tenants.view'
  | 'tenants.manage'
  | 'tenants.export'
  | 'billing.view'
  | 'billing.manage'
  | 'plans.manage'
  | 'analytics.view'
  | 'operations.view'
  | 'audit.view'
  | 'catalog.verify';

export const PLATFORM_ROLES: readonly PlatformRole[] = ['superadmin', 'support', 'billing', 'analyst'];

/**
 * Mirrors private.platform_role_permissions, which is what actually enforces access; this copy only
 * decides which screens and buttons to show. Change both together; platformAdmin.test.ts fails if
 * they drift apart.
 */
export const PLATFORM_ROLE_PERMISSIONS: Record<PlatformRole, readonly PlatformPermission[]> = {
  superadmin: [
    'admins.manage',
    'tenants.view',
    'tenants.manage',
    'tenants.export',
    'billing.view',
    'billing.manage',
    'plans.manage',
    'analytics.view',
    'operations.view',
    'audit.view',
    'catalog.verify',
  ],
  support: ['tenants.view', 'operations.view'],
  billing: ['tenants.view', 'billing.view', 'billing.manage'],
  analyst: ['analytics.view'],
};

export function isPlatformRole(value: unknown): value is PlatformRole {
  return typeof value === 'string' && (PLATFORM_ROLES as readonly string[]).includes(value);
}

export function canAdmin(role: PlatformRole | null | undefined, permission: PlatformPermission): boolean {
  return role ? PLATFORM_ROLE_PERMISSIONS[role].includes(permission) : false;
}

export type AdminSection = 'overview' | 'tenants' | 'catalog' | 'analytics' | 'billing' | 'admins' | 'operations' | 'audit';

export const ADMIN_SECTIONS: readonly AdminSection[] = [
  'overview',
  'tenants',
  'catalog',
  'analytics',
  'billing',
  'admins',
  'operations',
  'audit',
];

/** Whether a role may open a section. The overview shows platform-wide counts to every admin. */
export function canOpenSection(role: PlatformRole | null | undefined, section: AdminSection): boolean {
  if (!role) return false;
  switch (section) {
    case 'overview':
      return true;
    case 'tenants':
      return canAdmin(role, 'tenants.view');
    case 'catalog':
      return canAdmin(role, 'catalog.verify');
    case 'analytics':
      return canAdmin(role, 'analytics.view');
    case 'billing':
      return canAdmin(role, 'billing.view') || canAdmin(role, 'plans.manage');
    case 'admins':
      return canAdmin(role, 'admins.manage');
    case 'operations':
      return canAdmin(role, 'operations.view');
    case 'audit':
      return canAdmin(role, 'audit.view');
  }
}
