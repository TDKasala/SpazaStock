import type { ShopRole } from '../types';

export type Permission =
  | 'team.manage'
  | 'shop.settings'
  | 'billing.view'
  | 'products.edit'
  | 'stock.adjust'
  | 'expiry.manage'
  | 'stock.receive'
  | 'sales.record'
  | 'inventory.view'
  | 'orders.manage';

/**
 * Mirrors private.role_permissions in the database, which is what actually enforces access.
 * Change both together; teamManagement.test.ts fails if they drift apart.
 */
export const ROLE_PERMISSIONS: Record<ShopRole, readonly Permission[]> = {
  owner: [
    'team.manage',
    'shop.settings',
    'billing.view',
    'products.edit',
    'stock.adjust',
    'expiry.manage',
    'stock.receive',
    'sales.record',
    'inventory.view',
    'orders.manage',
  ],
  manager: ['products.edit', 'stock.adjust', 'expiry.manage', 'stock.receive', 'sales.record', 'inventory.view', 'orders.manage'],
  staff: ['stock.receive', 'sales.record', 'inventory.view'],
};

export function can(role: ShopRole | null | undefined, permission: Permission): boolean {
  return role ? ROLE_PERMISSIONS[role].includes(permission) : false;
}
