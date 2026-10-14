import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { isAuthRetryableFetchError } from '@supabase/supabase-js';
import { getSupabase } from '../lib/supabase';

/** 'device' = Supabase not configured, data stays on this device; 'cloud' = signed-in sync. */
export type AuthMode = 'device' | 'cloud';

export interface AuthUser {
  id: string;
  email: string | null;
}

interface AuthContextValue {
  mode: AuthMode;
  isLoading: boolean;
  user: AuthUser | null;
  /** True when signed in from the cached user because the session couldn't be refreshed offline. */
  isOfflineSession: boolean;
  sendCode: (email: string) => Promise<{ error?: string }>;
  verifyCode: (email: string, code: string) => Promise<{ error?: string }>;
  signOut: () => Promise<void>;
}

const LAST_USER_KEY = 'spazastock_last_user';

function readCachedUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem(LAST_USER_KEY);
    return raw ? (JSON.parse(raw) as AuthUser) : null;
  } catch {
    return null;
  }
}

function writeCachedUser(user: AuthUser | null): void {
  if (user) localStorage.setItem(LAST_USER_KEY, JSON.stringify(user));
  else localStorage.removeItem(LAST_USER_KEY);
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const supabase = getSupabase();
  const mode: AuthMode = supabase ? 'cloud' : 'device';
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isOfflineSession, setIsOfflineSession] = useState(false);
  const [isLoading, setIsLoading] = useState(mode === 'cloud');

  useEffect(() => {
    if (!supabase) return;
    let active = true;

    supabase.auth.getSession().then(({ data, error }) => {
      if (!active) return;
      if (data.session) {
        const next = { id: data.session.user.id, email: data.session.user.email ?? null };
        writeCachedUser(next);
        setUser(next);
        setIsOfflineSession(false);
      } else if (error && isAuthRetryableFetchError(error)) {
        const cached = readCachedUser();
        setUser(cached);
        setIsOfflineSession(cached !== null);
      } else {
        setUser(null);
      }
      setIsLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      if (session) {
        const next = { id: session.user.id, email: session.user.email ?? null };
        writeCachedUser(next);
        setUser(next);
        setIsOfflineSession(false);
      } else if (event === 'SIGNED_OUT') {
        writeCachedUser(null);
        setUser(null);
        setIsOfflineSession(false);
      }
    });

    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, [supabase]);

  const sendCode = useCallback(
    async (email: string) => {
      if (!supabase) return { error: 'Supabase is not configured.' };
      const { error } = await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: { emailRedirectTo: window.location.origin },
      });
      return error ? { error: error.message } : {};
    },
    [supabase]
  );

  const verifyCode = useCallback(
    async (email: string, code: string) => {
      if (!supabase) return { error: 'Supabase is not configured.' };
      const { error } = await supabase.auth.verifyOtp({
        email: email.trim(),
        token: code.trim(),
        type: 'email',
      });
      return error ? { error: error.message } : {};
    },
    [supabase]
  );

  const signOut = useCallback(async () => {
    if (!supabase) return;
    await supabase.auth.signOut({ scope: 'local' });
    writeCachedUser(null);
    setUser(null);
    setIsOfflineSession(false);
  }, [supabase]);

  const value = useMemo(
    () => ({ mode, isLoading, user, isOfflineSession, sendCode, verifyCode, signOut }),
    [mode, isLoading, user, isOfflineSession, sendCode, verifyCode, signOut]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
}
