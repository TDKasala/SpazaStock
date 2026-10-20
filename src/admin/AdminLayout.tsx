import React, { useEffect, useState } from 'react';
import {
  Activity,
  BarChart3,
  CreditCard,
  LayoutDashboard,
  LogOut,
  Menu,
  Package,
  ScrollText,
  Search,
  ShieldCheck,
  Store,
  UserCog,
  X,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useAdminIdentity } from './AdminContext';
import { useAdminI18n } from './i18n';
import { ADMIN_SECTIONS, canOpenSection, type AdminSection } from './permissions';
import { adminHref, navigateAdmin, useAdminRoute } from './router';
import { AdminLink } from './components/AdminLink';

const ICONS: Record<AdminSection, React.ComponentType<{ className?: string }>> = {
  overview: LayoutDashboard,
  tenants: Store,
  catalog: Package,
  analytics: BarChart3,
  billing: CreditCard,
  admins: UserCog,
  operations: Activity,
  audit: ScrollText,
};

const GlobalSearch: React.FC<{ onDone?: () => void }> = ({ onDone }) => {
  const { at } = useAdminI18n();
  const [query, setQuery] = useState('');
  return (
    <form
      role="search"
      className="relative"
      onSubmit={(e) => {
        e.preventDefault();
        const search = query.trim();
        navigateAdmin(adminHref('tenants', { params: { q: search } }));
        onDone?.();
      }}
    >
      <label htmlFor="admin-global-search" className="sr-only">
        {at('search.label')}
      </label>
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" aria-hidden="true" />
      <input
        id="admin-global-search"
        type="search"
        value={query}
        maxLength={100}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={at('search.placeholder')}
        className="w-full bg-zinc-900 border border-zinc-800 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 focus:outline-none rounded-xl pl-9 pr-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500"
      />
    </form>
  );
};

export const AdminLayout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { at, locale, setLocale } = useAdminI18n();
  const { signOut } = useAuth();
  const identity = useAdminIdentity();
  const route = useAdminRoute();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const canSearch = canOpenSection(identity.role, 'tenants');

  useEffect(() => {
    document.title = `${at(`nav.${route.section}`)} · ${at('app.title')}`;
  }, [at, route.section]);

  useEffect(() => setDrawerOpen(false), [route.section, route.tenantId]);

  const nav = (
    <nav aria-label={at('app.navigation')} className="flex flex-col gap-1">
      {ADMIN_SECTIONS.filter((section) => canOpenSection(identity.role, section)).map((section) => {
        const Icon = ICONS[section];
        const current = route.section === section;
        return (
          <AdminLink
            key={section}
            href={adminHref(section)}
            aria-current={current ? 'page' : undefined}
            className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-colors ${
              current ? 'bg-emerald-950/60 text-emerald-200 font-semibold' : 'text-zinc-300 hover:bg-zinc-800/70'
            }`}
          >
            <Icon className="w-4 h-4 shrink-0" />
            {at(`nav.${section}`)}
          </AdminLink>
        );
      })}
    </nav>
  );

  const footer = (
    <div className="space-y-3 pt-4 border-t border-zinc-800 text-xs text-zinc-400">
      <div>
        <p className="truncate text-zinc-300">{identity.email}</p>
        <p>{at(`roles.${identity.role}`)}</p>
      </div>
      <div className="flex gap-1" role="group" aria-label={at('app.language')}>
        {(['en', 'zu'] as const).map((code) => (
          <button
            key={code}
            type="button"
            onClick={() => setLocale(code)}
            aria-pressed={locale === code}
            className={`px-2.5 py-1 rounded-lg border ${
              locale === code ? 'border-emerald-600 text-emerald-200' : 'border-zinc-700 hover:border-zinc-500'
            }`}
          >
            {code === 'en' ? 'English' : 'isiZulu'}
          </button>
        ))}
      </div>
      <a href="/" className="flex items-center gap-2 hover:text-zinc-100">
        <Store className="w-4 h-4" />
        {at('app.backToShop')}
      </a>
      <button
        type="button"
        onClick={() => void signOut()}
        className="flex items-center gap-2 hover:text-zinc-100"
      >
        <LogOut className="w-4 h-4" />
        {at('app.signOut')}
      </button>
    </div>
  );

  const brand = (
    <div className="flex items-center gap-2 px-1">
      <ShieldCheck className="w-5 h-5 text-emerald-400" aria-hidden="true" />
      <span className="font-semibold text-sm">{at('app.title')}</span>
    </div>
  );

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans lg:flex">
      <a
        href="#admin-main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 bg-emerald-700 px-3 py-2 rounded-lg"
      >
        {at('app.skipToContent')}
      </a>

      <aside className="hidden lg:flex lg:w-64 lg:shrink-0 flex-col gap-6 border-r border-zinc-800 p-4 sticky top-0 h-screen overflow-y-auto">
        {brand}
        {nav}
        <div className="mt-auto">{footer}</div>
      </aside>

      {drawerOpen && (
        <div className="lg:hidden fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label={at('app.navigation')}>
          <div className="absolute inset-0 bg-black/70" onClick={() => setDrawerOpen(false)} aria-hidden="true" />
          <div className="relative w-72 max-w-[85vw] h-full bg-zinc-950 border-r border-zinc-800 p-4 flex flex-col gap-6 overflow-y-auto">
            <div className="flex items-center justify-between">
              {brand}
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                aria-label={at('app.closeMenu')}
                className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            {canSearch && <GlobalSearch onDone={() => setDrawerOpen(false)} />}
            {nav}
            <div className="mt-auto">{footer}</div>
          </div>
        </div>
      )}

      <div className="flex-1 min-w-0 flex flex-col">
        <header className="sticky top-0 z-30 bg-zinc-950/90 backdrop-blur border-b border-zinc-800 px-4 py-3 flex items-center gap-3">
          <button
            type="button"
            className="lg:hidden p-1.5 rounded-lg text-zinc-300 hover:bg-zinc-800"
            onClick={() => setDrawerOpen(true)}
            aria-label={at('app.openMenu')}
            aria-expanded={drawerOpen}
          >
            <Menu className="w-5 h-5" />
          </button>
          <div className="lg:hidden">{brand}</div>
          {canSearch && (
            <div className="hidden sm:block flex-1 max-w-md ml-auto lg:ml-0">
              <GlobalSearch />
            </div>
          )}
        </header>
        <main id="admin-main" className="flex-1 w-full max-w-7xl mx-auto px-4 py-6 space-y-6">
          {children}
        </main>
      </div>
    </div>
  );
};
