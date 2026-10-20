import React from 'react';
import { ShieldAlert } from 'lucide-react';
import { AdminGuard } from './AdminGuard';
import { AdminLayout } from './AdminLayout';
import { useAdminIdentity } from './AdminContext';
import { useAdminI18n } from './i18n';
import { canOpenSection } from './permissions';
import { useAdminRoute } from './router';
import { OverviewPage } from './pages/OverviewPage';
import { TenantsPage } from './pages/TenantsPage';
import { CatalogPage } from './pages/CatalogPage';
import { CatalogEditorPage } from './pages/CatalogEditorPage';
import { TenantDetailPage } from './pages/TenantDetailPage';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { BillingPage } from './pages/BillingPage';
import { AdminsPage } from './pages/AdminsPage';
import { OperationsPage } from './pages/OperationsPage';
import { AuditPage } from './pages/AuditPage';

function CurrentPage() {
  const { at } = useAdminI18n();
  const identity = useAdminIdentity();
  const route = useAdminRoute();

  if (!canOpenSection(identity.role, route.section)) {
    return (
      <div className="flex items-start gap-3 p-4 rounded-xl border border-amber-800/60 bg-amber-950/30 text-amber-200 text-sm">
        <ShieldAlert className="w-5 h-5 shrink-0" aria-hidden="true" />
        <p>{at('guard.sectionDenied')}</p>
      </div>
    );
  }

  switch (route.section) {
    case 'overview':
      return <OverviewPage />;
    case 'tenants':
      return route.tenantId ? <TenantDetailPage key={route.tenantId} shopId={route.tenantId} /> : <TenantsPage />;
    case 'catalog':
      return route.catalogId ? (
        <CatalogEditorPage key={route.catalogId} catalogId={route.catalogId} />
      ) : (
        <CatalogPage />
      );
    case 'analytics':
      return <AnalyticsPage />;
    case 'billing':
      return <BillingPage />;
    case 'admins':
      return <AdminsPage />;
    case 'operations':
      return <OperationsPage />;
    case 'audit':
      return <AuditPage />;
  }
}

/** Platform administration, loaded only at /admin. */
export const AdminApp: React.FC = () => (
  <AdminGuard>
    <AdminLayout>
      <CurrentPage />
    </AdminLayout>
  </AdminGuard>
);
