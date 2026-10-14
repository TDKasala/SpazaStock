import React, { useCallback, useEffect, useState } from 'react';
import { ShieldAlert, WifiOff } from 'lucide-react';
import { LoadingState } from '../components/ui/LoadingState';
import { Button } from '../components/ui/Button';
import { AdminError, adminApi } from './api';
import { AdminContext, type AdminIdentity } from './AdminContext';
import { useAdminI18n } from './i18n';
import { isPlatformRole, PLATFORM_ROLE_PERMISSIONS } from './permissions';
import type { WhoAmI } from './types';

export type GuardState =
  | { kind: 'checking' }
  | { kind: 'offline' }
  | { kind: 'error' }
  | { kind: 'denied' }
  | { kind: 'allowed'; identity: AdminIdentity };

/**
 * What the guard shows for an admin_whoami answer. Only the server's role counts; the screens are
 * hidden from everyone else, and every admin function checks the role again regardless.
 */
export function guardStateFrom(result: WhoAmI | null, error: unknown): GuardState {
  if (error) return error instanceof AdminError && error.kind === 'network' ? { kind: 'offline' } : { kind: 'error' };
  if (!result) return { kind: 'checking' };
  if (!isPlatformRole(result.role)) return { kind: 'denied' };
  return {
    kind: 'allowed',
    identity: {
      role: result.role,
      email: result.email,
      // The local matrix only decides what to show; unknown server permissions are ignored.
      permissions: PLATFORM_ROLE_PERMISSIONS[result.role].filter((p) => result.permissions.includes(p)),
    },
  };
}

const Shell: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-6">
    <div className="max-w-sm w-full text-center space-y-4">{children}</div>
  </div>
);

export const AdminGuard: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { at } = useAdminI18n();
  const [state, setState] = useState<GuardState>({ kind: 'checking' });

  const check = useCallback(() => {
    setState({ kind: 'checking' });
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setState({ kind: 'offline' });
      return;
    }
    adminApi
      .whoami()
      .then((result) => setState(guardStateFrom(result, null)))
      .catch((err: unknown) => setState(guardStateFrom(null, err)));
  }, []);

  useEffect(check, [check]);

  switch (state.kind) {
    case 'checking':
      return (
        <Shell>
          <LoadingState message={at('guard.checking')} />
        </Shell>
      );
    case 'allowed':
      return <AdminContext.Provider value={state.identity}>{children}</AdminContext.Provider>;
    case 'denied':
      return (
        <Shell>
          <ShieldAlert className="w-10 h-10 text-rose-400 mx-auto" aria-hidden="true" />
          <h1 className="text-lg font-semibold">{at('guard.deniedTitle')}</h1>
          <p className="text-sm text-zinc-400">{at('guard.denied')}</p>
          <a href="/" className="inline-block text-sm text-emerald-400 hover:text-emerald-300 underline">
            {at('app.backToShop')}
          </a>
        </Shell>
      );
    default:
      return (
        <Shell>
          {state.kind === 'offline' ? (
            <WifiOff className="w-10 h-10 text-amber-400 mx-auto" aria-hidden="true" />
          ) : (
            <ShieldAlert className="w-10 h-10 text-amber-400 mx-auto" aria-hidden="true" />
          )}
          <p className="text-sm text-zinc-300">{at(state.kind === 'offline' ? 'guard.offline' : 'guard.error')}</p>
          <Button onClick={check}>{at('common.retry')}</Button>
        </Shell>
      );
  }
};
