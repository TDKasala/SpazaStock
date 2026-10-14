import { createContext, useContext } from 'react';
import type { PlatformPermission, PlatformRole } from './permissions';

export interface AdminIdentity {
  role: PlatformRole;
  email: string | null;
  permissions: readonly PlatformPermission[];
}

export const AdminContext = createContext<AdminIdentity | null>(null);

export function useAdminIdentity(): AdminIdentity {
  const identity = useContext(AdminContext);
  if (!identity) throw new Error('useAdminIdentity must be used inside AdminGuard');
  return identity;
}
