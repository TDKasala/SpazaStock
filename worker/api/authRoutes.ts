/** /api/auth/*: the Worker's replacement for Supabase Auth's HTTP API. */
import { Auth, AuthError } from '../auth/service';
import { cloudflareMailer } from '../auth/email';
import type { Env } from '../env';
import { authFail, bearer, ok, readJson } from './http';

export function authFor(env: Env): Auth {
  return new Auth({ db: env.DB, mailer: cloudflareMailer(env.EMAIL, env.EMAIL_FROM), secret: env.AUTH_SECRET });
}

export async function handleAuth(request: Request, env: Env, path: string): Promise<Response> {
  const auth = authFor(env);
  const body = await readJson(request);
  const agent = request.headers.get('User-Agent');
  try {
    switch (`${request.method} ${path}`) {
      case 'POST /api/auth/signup':
        return ok(await auth.signUp(body.email, body.password, (body.data as Record<string, unknown>) ?? {}));
      case 'POST /api/auth/otp':
        await auth.signInWithOtp(body.email);
        return ok({});
      case 'POST /api/auth/verify':
        return ok(await auth.verifyOtp(body.email, body.token, body.type, agent));
      case 'POST /api/auth/resend':
        if (body.type !== 'signup') return authFail('validation_failed', 400, 'Only sign-up codes can be resent.');
        await auth.resendSignup(body.email);
        return ok({});
      case 'POST /api/auth/password':
        return ok(await auth.signInWithPassword(body.email, body.password, agent));
      case 'POST /api/auth/recover':
        await auth.requestRecovery(body.email);
        return ok({});
      case 'POST /api/auth/refresh':
        return ok(await auth.refresh(body.refresh_token));
    }
    // Everything below needs a signed-in session.
    const session = await auth.userForToken(bearer(request));
    if (!session) return authFail('no_session', 401, 'Auth session missing!');
    switch (`${request.method} ${path}`) {
      case 'GET /api/auth/user':
        return ok(session.user);
      case 'PUT /api/auth/user':
        return ok(await auth.updatePassword(session.claims, body.password));
      case 'POST /api/auth/logout':
        await auth.signOut(session.claims);
        return ok({});
    }
    return authFail('not_found', 404, 'Not found');
  } catch (err) {
    if (err instanceof AuthError) return authFail(err.code, err.status, err.message);
    console.error('auth error', err);
    return authFail('unexpected_failure', 500, 'Something went wrong.');
  }
}
