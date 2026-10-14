import { useSyncExternalStore } from 'react';
import type { AdminSection } from './permissions';

export interface AdminRoute {
  section: AdminSection;
  /** Set on /admin/tenants/:id. */
  tenantId: string | null;
  params: URLSearchParams;
}

const SECTION_PATHS: Record<string, AdminSection> = {
  '': 'overview',
  tenants: 'tenants',
  analytics: 'analytics',
  billing: 'billing',
  admins: 'admins',
  operations: 'operations',
  audit: 'audit',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseAdminLocation(pathname: string, search: string): AdminRoute {
  const parts = pathname.replace(/^\/admin\/?/, '').split('/').filter(Boolean);
  const section = SECTION_PATHS[parts[0] ?? ''] ?? 'overview';
  const tenantId = section === 'tenants' && parts[1] && UUID.test(parts[1]) ? parts[1].toLowerCase() : null;
  return { section, tenantId, params: new URLSearchParams(search) };
}

export function adminHref(
  section: AdminSection,
  options: { tenantId?: string; params?: Record<string, string | null | undefined> } = {}
): string {
  let path = section === 'overview' ? '/admin' : `/admin/${section}`;
  if (options.tenantId) path += `/${options.tenantId}`;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(options.params ?? {})) {
    if (value) query.set(key, value);
  }
  const qs = query.toString();
  return qs ? `${path}?${qs}` : path;
}

const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener('popstate', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('popstate', listener);
  };
}

function snapshot() {
  return window.location.pathname + window.location.search;
}

export function navigateAdmin(href: string, options: { replace?: boolean } = {}) {
  if (href === snapshot()) return;
  if (options.replace) window.history.replaceState(null, '', href);
  else window.history.pushState(null, '', href);
  listeners.forEach((listener) => listener());
}

export function useAdminRoute(): AdminRoute {
  const location = useSyncExternalStore(subscribe, snapshot, snapshot);
  const queryAt = location.indexOf('?');
  return queryAt === -1
    ? parseAdminLocation(location, '')
    : parseAdminLocation(location.slice(0, queryAt), location.slice(queryAt));
}
