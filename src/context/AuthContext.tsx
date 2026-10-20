import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { isAuthRetryableFetchError } from '@supabase/supabase-js';
import { getSupabase } from '../lib/supabase';
import { authErrorKey } from '../lib/authErrors';
import { normalizeDisplayName, normalizeEmail } from '../lib/authValidation';
import { clearFreshSignIn, markFreshSignIn } from '../lib/platformAdmin';
import { onDataChanged } from '../lib/events';
import {
  countsAsUserActivity,
  createIdleClock,
  IDLE_CHECK_MS,
  markIdleSignOut,
  readLastActivity,
  writeLastActivity,
} from '../lib/idleSignOut';
import { loginHref, requestSignInScreen } from '../lib/signInRedirect';

/** 'device' = Supabase not configured, data stays on this device; 'cloud' = signed-in sync. */
export type AuthMode = 'device' | 'cloud';

export interface AuthUser {
  id: string;
  email: string | null;
}

/** `error` is a translation key. */
export interface AuthResult {
  error?: string;
}

export interface SignUpResult extends AuthResult {
  /** True when the account exists but the emailed code must be entered before signing in. */
  needsConfirmation?: boolean;
}

interface AuthContextValue {
  mode: AuthMode;
  isLoading: boolean;
  user: AuthUser | null;
  /** True when signed in from the cached user because the session couldn't be refreshed offline. */
  isOfflineSession: boolean;
  /** Signed in with a password-reset code; a new password must be chosen before continuing. */
  isRecoveringPassword: boolean;
  sendCode: (email: string) => Promise<AuthResult>;
  verifyCode: (email: string, code: string) => Promise<AuthResult>;
  signUp: (email: string, password: string, displayName: string) => Promise<SignUpResult>;
  confirmSignUp: (email: string, code: string) => Promise<AuthResult>;
  resendSignUpCode: (email: string) => Promise<AuthResult>;
  signInWithPassword: (email: string, password: string) => Promise<SignUpResult>;
  requestPasswordReset: (email: string) => Promise<AuthResult>;
  verifyResetCode: (email: string, code: string) => Promise<AuthResult>;
  updatePassword: (password: string) => Promise<AuthResult>;
  finishPasswordRecovery: () => void;
  signOut: () => Promise<void>;
}

const LAST_USER_KEY = 'spazastock_last_user';
const RECOVERY_KEY = 'spazastock_password_recovery';
const NOT_CONFIGURED = 'auth.errors.generic';

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

function readRecoveryFlag(): boolean {
  try {
    return sessionStorage.getItem(RECOVERY_KEY) === '1';
  } catch {
    return false;
  }
}

function writeRecoveryFlag(value: boolean): void {
  try {
    if (value) sessionStorage.setItem(RECOVERY_KEY, '1');
    else sessionStorage.removeItem(RECOVERY_KEY);
  } catch {
    // Private browsing without storage: the flag only lives in memory.
  }
}

function redirectTo(): string {
  return window.location.origin;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const supabase = getSupabase();
  const mode: AuthMode = supabase ? 'cloud' : 'device';
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isOfflineSession, setIsOfflineSession] = useState(false);
  const [isLoading, setIsLoading] = useState(mode === 'cloud');
  const [isRecoveringPassword, setIsRecoveringPassword] = useState(readRecoveryFlag);

  const setRecovering = useCallback((value: boolean) => {
    writeRecoveryFlag(value);
    setIsRecoveringPassword(value);
  }, []);

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
        setRecovering(false);
      }
      setIsLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY') setRecovering(true);
      if (session) {
        const next = { id: session.user.id, email: session.user.email ?? null };
        if (event === 'SIGNED_IN') writeLastActivity(next.id, Date.now());
        writeCachedUser(next);
        setUser(next);
        setIsOfflineSession(false);
      } else if (event === 'SIGNED_OUT') {
        writeCachedUser(null);
        setUser(null);
        setIsOfflineSession(false);
        setRecovering(false);
      }
    });

    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, [supabase, setRecovering]);

  const sendCode = useCallback(
    async (email: string): Promise<AuthResult> => {
      if (!supabase) return { error: NOT_CONFIGURED };
      const { error } = await supabase.auth.signInWithOtp({
        email: normalizeEmail(email),
        options: { emailRedirectTo: redirectTo() },
      });
      return error ? { error: authErrorKey(error) } : {};
    },
    [supabase]
  );

  const verifyCode = useCallback(
    async (email: string, code: string): Promise<AuthResult> => {
      if (!supabase) return { error: NOT_CONFIGURED };
      // Set first: the session arrives before verifyOtp resolves.
      markFreshSignIn();
      const { error } = await supabase.auth.verifyOtp({
        email: normalizeEmail(email),
        token: code.trim(),
        type: 'email',
      });
      if (error) clearFreshSignIn();
      return error ? { error: authErrorKey(error) } : {};
    },
    [supabase]
  );

  const signUp = useCallback(
    async (email: string, password: string, displayName: string): Promise<SignUpResult> => {
      if (!supabase) return { error: NOT_CONFIGURED };
      const { data, error } = await supabase.auth.signUp({
        email: normalizeEmail(email),
        password,
        options: { data: { display_name: normalizeDisplayName(displayName) }, emailRedirectTo: redirectTo() },
      });
      if (error) return { error: authErrorKey(error) };
      // Supabase hides whether an address is registered by returning a user without identities.
      if (data.user && data.user.identities?.length === 0) return { error: 'auth.errors.emailInUse' };
      return { needsConfirmation: !data.session };
    },
    [supabase]
  );

  // The 'email' verification type accepts both sign-up confirmation and sign-in codes.
  const confirmSignUp = verifyCode;

  const resendSignUpCode = useCallback(
    async (email: string): Promise<AuthResult> => {
      if (!supabase) return { error: NOT_CONFIGURED };
      const { error } = await supabase.auth.resend({
        type: 'signup',
        email: normalizeEmail(email),
        options: { emailRedirectTo: redirectTo() },
      });
      return error ? { error: authErrorKey(error) } : {};
    },
    [supabase]
  );

  const signInWithPassword = useCallback(
    async (email: string, password: string): Promise<SignUpResult> => {
      if (!supabase) return { error: NOT_CONFIGURED };
      markFreshSignIn();
      const { error } = await supabase.auth.signInWithPassword({ email: normalizeEmail(email), password });
      if (!error) return {};
      clearFreshSignIn();
      const key = authErrorKey(error);
      if (key === 'auth.errors.emailNotConfirmed') {
        await supabase.auth.resend({ type: 'signup', email: normalizeEmail(email) });
        return { error: key, needsConfirmation: true };
      }
      return { error: key };
    },
    [supabase]
  );

  const requestPasswordReset = useCallback(
    async (email: string): Promise<AuthResult> => {
      if (!supabase) return { error: NOT_CONFIGURED };
      const { error } = await supabase.auth.resetPasswordForEmail(normalizeEmail(email), {
        redirectTo: redirectTo(),
      });
      return error ? { error: authErrorKey(error) } : {};
    },
    [supabase]
  );

  const verifyResetCode = useCallback(
    async (email: string, code: string): Promise<AuthResult> => {
      if (!supabase) return { error: NOT_CONFIGURED };
      // Set first: the session arrives before verifyOtp resolves, and the app must show the
      // new-password step rather than the shop.
      setRecovering(true);
      const { error } = await supabase.auth.verifyOtp({
        email: normalizeEmail(email),
        token: code.trim(),
        type: 'recovery',
      });
      if (error) {
        setRecovering(false);
        return { error: authErrorKey(error) };
      }
      return {};
    },
    [supabase, setRecovering]
  );

  const updatePassword = useCallback(
    async (password: string): Promise<AuthResult> => {
      if (!supabase) return { error: NOT_CONFIGURED };
      const { error } = await supabase.auth.updateUser({ password });
      return error ? { error: authErrorKey(error) } : {};
    },
    [supabase]
  );

  const finishPasswordRecovery = useCallback(() => setRecovering(false), [setRecovering]);

  const signOut = useCallback(async () => {
    if (!supabase) return;
    await supabase.auth.signOut({ scope: 'local' });
    clearFreshSignIn();
    writeCachedUser(null);
    setUser(null);
    setIsOfflineSession(false);
    setRecovering(false);
    requestSignInScreen();
    window.location.replace(loginHref());
  }, [supabase, setRecovering]);

  const signOutRef = useRef(signOut);
  signOutRef.current = signOut;

  const userId = user?.id ?? null;

  useEffect(() => {
    if (!userId) return;
    const stored = readLastActivity(userId);
    const startedAt = stored ?? Date.now();
    if (stored === null) writeLastActivity(userId, startedAt);
    const clock = createIdleClock(startedAt);
    let signingOut = false;
    let lastPersisted = startedAt;
    const mark = () => {
      const now = Date.now();
      clock.mark(now);
      if (now - lastPersisted < 5_000) return;
      lastPersisted = now;
      writeLastActivity(userId, now);
    };
    const check = () => {
      if (signingOut || !clock.isIdle(Date.now())) return;
      signingOut = true;
      markIdleSignOut();
      void signOutRef.current().catch(() => {
        window.location.replace(loginHref());
      });
    };
    const options: AddEventListenerOptions = { capture: true, passive: true };
    const events = ['pointerdown', 'keydown', 'scroll'] as const;
    for (const event of events) window.addEventListener(event, mark, options);
    const stopData = onDataChanged((source) => {
      if (countsAsUserActivity(source)) mark();
    });
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    check();
    const timer = window.setInterval(check, IDLE_CHECK_MS);
    return () => {
      for (const event of events) window.removeEventListener(event, mark, options);
      stopData();
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('focus', check);
      window.clearInterval(timer);
    };
  }, [userId]);

  const value = useMemo(
    () => ({
      mode,
      isLoading,
      user,
      isOfflineSession,
      isRecoveringPassword,
      sendCode,
      verifyCode,
      signUp,
      confirmSignUp,
      resendSignUpCode,
      signInWithPassword,
      requestPasswordReset,
      verifyResetCode,
      updatePassword,
      finishPasswordRecovery,
      signOut,
    }),
    [
      mode,
      isLoading,
      user,
      isOfflineSession,
      isRecoveringPassword,
      sendCode,
      verifyCode,
      signUp,
      confirmSignUp,
      resendSignUpCode,
      signInWithPassword,
      requestPasswordReset,
      verifyResetCode,
      updatePassword,
      finishPasswordRecovery,
      signOut,
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
}
