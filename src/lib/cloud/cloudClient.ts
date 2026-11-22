/**
 * A Cloudflare-backed stand-in for the slice of supabase-js SpazaStock uses, so the app's
 * services, sync engine and contexts work unchanged against the Worker API (worker/index.ts):
 *
 *   auth.*                 /api/auth/*        sessions kept in localStorage, refreshed before expiry
 *   rpc(name, args)        /api/rpc/:name
 *   from(table)...         /api/table         the few direct reads/writes, plus the delta pull
 *   storage.from(bucket)   /api/images/*      product pictures in R2
 *   functions.invoke       /api/product-lookup
 *
 * Results keep supabase-js's shapes: { data, error } with Postgres-style error codes, auth errors
 * with `code`/`status`, and network failures as AuthRetryableFetchError so offline sign-in works.
 */

type AuthEvent = 'INITIAL_SESSION' | 'SIGNED_IN' | 'SIGNED_OUT' | 'TOKEN_REFRESHED' | 'USER_UPDATED' | 'PASSWORD_RECOVERY';

export interface CloudUser {
  id: string;
  email: string;
  email_confirmed_at: string | null;
  user_metadata: Record<string, unknown>;
  identities: unknown[];
  [key: string]: unknown;
}

export interface CloudSession {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  expires_in: number;
  token_type: 'bearer';
  user: CloudUser;
}

export interface ApiError {
  code: string;
  message: string;
  status?: number;
  details?: string | null;
  hint?: string | null;
}

type Result<T> = { data: T; error: null } | { data: null; error: ApiError };

const STORAGE_KEY = 'spazastock.auth.session';
const REFRESH_MARGIN_S = 60;

/** Shaped like supabase-js's auth errors, so isAuthRetryableFetchError() recognises network failures. */
class CloudAuthError extends Error {
  readonly __isAuthError = true;
  readonly code: string;
  readonly status: number;
  constructor(name: string, code: string, status: number, message: string) {
    super(message);
    this.name = name;
    this.code = code;
    this.status = status;
  }
}

const networkError = (err: unknown) =>
  new CloudAuthError('AuthRetryableFetchError', 'network', 0, err instanceof Error ? err.message : 'Failed to fetch');

function readStored(): CloudSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as CloudSession) : null;
  } catch {
    return null;
  }
}

function writeStored(session: CloudSession | null): void {
  try {
    if (session) localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private browsing without storage: the session lives in memory only.
  }
}

export function createCloudClient(apiBase = '') {
  const base = apiBase.replace(/\/+$/, '');
  let session: CloudSession | null = readStored();
  let refreshing: Promise<CloudSession | null> | null = null;
  const listeners = new Set<(event: AuthEvent, session: CloudSession | null) => void>();

  const emit = (event: AuthEvent) => {
    for (const listener of [...listeners]) {
      try {
        listener(event, session);
      } catch (err) {
        console.error(err);
      }
    }
  };

  const setSession = (next: CloudSession | null, event: AuthEvent) => {
    session = next;
    writeStored(next);
    emit(event);
  };

  async function call(path: string, init: RequestInit & { json?: unknown; token?: string | null } = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (init.json !== undefined) headers.set('Content-Type', 'application/json');
    if (init.token) headers.set('Authorization', `Bearer ${init.token}`);
    return fetch(`${base}${path}`, {
      ...init,
      headers,
      body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
    });
  }

  /** Auth endpoints: throws CloudAuthError (network or API) on failure. */
  async function authCall<T>(path: string, json: unknown, method = 'POST', token: string | null = null): Promise<T> {
    let res: Response;
    try {
      res = await call(path, { method, json, token });
    } catch (err) {
      throw networkError(err);
    }
    const body = (await res.json().catch(() => ({}))) as { data?: T; error?: { code: string; message: string; status?: number } };
    if (!res.ok || body.error) {
      const e = body.error ?? { code: 'unexpected_failure', message: res.statusText };
      throw new CloudAuthError('AuthApiError', e.code, e.status ?? res.status, e.message);
    }
    return body.data as T;
  }

  async function refreshSession(): Promise<CloudSession | null> {
    if (!session) return null;
    refreshing ??= (async () => {
      try {
        const next = await authCall<CloudSession>('/api/auth/refresh', { refresh_token: session!.refresh_token });
        setSession(next, 'TOKEN_REFRESHED');
        return next;
      } catch (err) {
        // Offline: keep the session for when the network is back. Refused: signed out.
        if (err instanceof CloudAuthError && err.name !== 'AuthRetryableFetchError') setSession(null, 'SIGNED_OUT');
        throw err;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  /** A current access token, refreshed when about to expire; null when signed out or offline. */
  async function accessToken(): Promise<string | null> {
    if (!session) return null;
    if (session.expires_at - REFRESH_MARGIN_S > Date.now() / 1000) return session.access_token;
    try {
      return (await refreshSession())?.access_token ?? null;
    } catch {
      return session?.access_token ?? null;
    }
  }

  // Keep the token fresh while the app is open, as supabase-js's autoRefreshToken did.
  if (typeof window !== 'undefined') {
    setInterval(() => {
      if (session && session.expires_at - REFRESH_MARGIN_S * 2 < Date.now() / 1000 && navigator.onLine !== false) {
        refreshSession().catch(() => {});
      }
    }, 30_000);
  }

  /** Data endpoints: never throw; network failures become { error } like PostgREST's fetch errors. */
  async function dataCall<T>(path: string, json: unknown): Promise<Result<T>> {
    try {
      const res = await call(path, { method: 'POST', json, token: await accessToken() });
      const body = (await res.json().catch(() => ({}))) as { data?: T; error?: ApiError };
      if (body.error) return { data: null, error: { details: null, hint: null, ...body.error } };
      if (!res.ok) return { data: null, error: { code: String(res.status), message: res.statusText, details: null, hint: null } };
      return { data: body.data as T, error: null };
    } catch (err) {
      return { data: null, error: { code: '', message: `TypeError: ${err instanceof Error ? err.message : 'Failed to fetch'}`, details: null, hint: null } };
    }
  }

  const authResult = async <T>(fn: () => Promise<T>) => {
    try {
      return { data: await fn(), error: null };
    } catch (err) {
      return { data: null, error: err as CloudAuthError };
    }
  };

  const auth = {
    async getSession() {
      if (!session) return { data: { session: null }, error: null };
      if (session.expires_at - REFRESH_MARGIN_S > Date.now() / 1000) return { data: { session }, error: null };
      try {
        return { data: { session: await refreshSession() }, error: null };
      } catch (err) {
        return { data: { session: null }, error: err as CloudAuthError };
      }
    },
    onAuthStateChange(cb: (event: AuthEvent, session: CloudSession | null) => void) {
      listeners.add(cb);
      queueMicrotask(() => cb('INITIAL_SESSION', session));
      return { data: { subscription: { unsubscribe: () => listeners.delete(cb) } } };
    },
    signInWithOtp: ({ email }: { email: string; options?: unknown }) =>
      authResult(async () => {
        await authCall('/api/auth/otp', { email });
        return { user: null, session: null };
      }),
    verifyOtp: ({ email, token, type }: { email: string; token: string; type: string }) =>
      authResult(async () => {
        const next = await authCall<CloudSession>('/api/auth/verify', { email, token, type });
        setSession(next, 'SIGNED_IN');
        if (type === 'recovery') emit('PASSWORD_RECOVERY');
        return { user: next.user, session: next };
      }),
    signUp: ({ email, password, options }: { email: string; password: string; options?: { data?: Record<string, unknown> } }) =>
      authResult(async () => {
        const res = await authCall<{ user: CloudUser; session: null }>('/api/auth/signup', { email, password, data: options?.data ?? {} });
        return { user: res.user, session: null };
      }),
    resend: ({ type, email }: { type: string; email: string; options?: unknown }) =>
      authResult(async () => {
        await authCall('/api/auth/resend', { type, email });
        return { user: null, session: null };
      }),
    signInWithPassword: ({ email, password }: { email: string; password: string }) =>
      authResult(async () => {
        const next = await authCall<CloudSession>('/api/auth/password', { email, password });
        setSession(next, 'SIGNED_IN');
        return { user: next.user, session: next };
      }),
    resetPasswordForEmail: (email: string, _options?: unknown) =>
      authResult(async () => {
        await authCall('/api/auth/recover', { email });
        return {};
      }),
    updateUser: ({ password }: { password: string }) =>
      authResult(async () => {
        const user = await authCall<CloudUser>('/api/auth/user', { password }, 'PUT', await accessToken());
        // A password-reset session becomes a normal one: fetch a token without the reset limit.
        await refreshSession().catch(() => {});
        emit('USER_UPDATED');
        return { user };
      }),
    async signOut(_options?: { scope?: string }) {
      const token = session?.access_token ?? null;
      setSession(null, 'SIGNED_OUT');
      if (token) await call('/api/auth/logout', { method: 'POST', json: {}, token }).catch(() => {});
      return { error: null };
    },
  };

  /** The query-builder slice the app uses on tables: eq/gt filters, order, range/limit, single rows. */
  function from(table: string) {
    const q: { op: 'select' | 'update'; eq: Record<string, unknown>; gt: Record<string, unknown>; values?: unknown; offset?: number; limit?: number; single?: boolean } = {
      op: 'select',
      eq: {},
      gt: {},
    };
    const run = async () => {
      const result = await dataCall<unknown[]>('/api/table', {
        table,
        op: q.op,
        eq: q.eq,
        gt: Object.keys(q.gt).length ? q.gt : undefined,
        values: q.values,
        offset: q.offset,
        limit: q.limit,
      });
      if (result.error || !q.single) return result;
      const rows = (result.data ?? []) as unknown[];
      return { data: rows[0] ?? null, error: null };
    };
    const builder = {
      select(_columns?: string) {
        return builder;
      },
      update(values: unknown) {
        q.op = 'update';
        q.values = values;
        return builder;
      },
      eq(column: string, value: unknown) {
        q.eq[column] = value;
        return builder;
      },
      gt(column: string, value: unknown) {
        q.gt[column] = value;
        return builder;
      },
      order(_column: string, _options?: unknown) {
        return builder;
      },
      range(fromRow: number, toRow: number) {
        q.offset = fromRow;
        q.limit = toRow - fromRow + 1;
        return builder;
      },
      limit(n: number) {
        q.limit = n;
        return builder;
      },
      maybeSingle() {
        q.single = true;
        return run();
      },
      then<R1, R2>(resolve: (v: Awaited<ReturnType<typeof run>>) => R1, reject?: (e: unknown) => R2) {
        return run().then(resolve, reject);
      },
    };
    return builder;
  }

  const storage = {
    from(_bucket: string) {
      const url = (path: string) => `/api/images/${path.split('/').map(encodeURIComponent).join('/')}`;
      return {
        async upload(path: string, body: Blob | ArrayBuffer | Uint8Array, options?: { contentType?: string; upsert?: boolean }) {
          try {
            const res = await call(`${url(path)}${options?.upsert ? '?upsert=1' : ''}`, {
              method: 'PUT',
              body: body as BodyInit,
              headers: { 'Content-Type': options?.contentType ?? 'application/octet-stream' },
              token: await accessToken(),
            });
            const json = (await res.json().catch(() => ({}))) as { statusCode?: string; message?: string; path?: string };
            if (!res.ok) return { data: null, error: { name: 'StorageApiError', message: json.message ?? res.statusText, statusCode: json.statusCode ?? String(res.status), status: res.status } };
            return { data: { path: json.path ?? path, id: path, fullPath: `product-images/${path}` }, error: null };
          } catch (err) {
            return { data: null, error: { name: 'StorageUnknownError', message: err instanceof Error ? err.message : 'Failed to fetch', statusCode: '0', status: 0 } };
          }
        },
        async download(path: string) {
          try {
            const res = await call(url(path), { method: 'GET', token: await accessToken() });
            if (!res.ok) {
              const json = (await res.json().catch(() => ({}))) as { statusCode?: string; message?: string };
              return { data: null, error: { name: 'StorageApiError', message: json.message ?? res.statusText, statusCode: json.statusCode ?? String(res.status), status: res.status } };
            }
            return { data: await res.blob(), error: null };
          } catch (err) {
            return { data: null, error: { name: 'StorageUnknownError', message: err instanceof Error ? err.message : 'Failed to fetch', statusCode: '0', status: 0 } };
          }
        },
        async remove(paths: string[]) {
          const removed: { name: string }[] = [];
          for (const path of paths) {
            try {
              const res = await call(url(path), { method: 'DELETE', token: await accessToken() });
              removed.push(...((await res.json().catch(() => [])) as { name: string }[]));
            } catch {
              // Best effort, like the app expects.
            }
          }
          return { data: removed, error: null };
        },
      };
    },
  };

  const functions = {
    async invoke<T>(name: string, options?: { body?: unknown }) {
      if (name !== 'product-lookup') return { data: null, error: new Error(`Unknown function ${name}`) };
      try {
        const res = await call('/api/product-lookup', { method: 'POST', json: options?.body ?? {}, token: await accessToken() });
        if (!res.ok) return { data: null, error: new Error(`HTTP ${res.status}`) };
        return { data: (await res.json()) as T, error: null };
      } catch (err) {
        return { data: null, error: err as Error };
      }
    },
  };

  return {
    auth,
    rpc: <T = unknown>(name: string, args: Record<string, unknown> = {}) => dataCall<T>(`/api/rpc/${encodeURIComponent(name)}`, args),
    from,
    storage,
    functions,
  };
}

export type CloudClient = ReturnType<typeof createCloudClient>;
