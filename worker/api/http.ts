/** JSON responses for the API, in the shapes the app's client shim expects. */
import { errorBody } from '../db/errors';

const NO_STORE = { 'Cache-Control': 'no-store' };

export function ok(data: unknown, status = 200): Response {
  return Response.json({ data: data ?? null }, { status, headers: NO_STORE });
}

/** HTTP status for a Postgres-style error code (the body carries the code itself). */
export function statusFor(code: string): number {
  if (code === '42501') return 403;
  if (code === 'P0002') return 404;
  if (code === '23505') return 409;
  if (code === '42883') return 404;
  if (code === 'XX000') return 500;
  return 400;
}

export function fail(err: unknown): Response {
  const body = errorBody(err);
  if (body.code === 'XX000') console.error('api error', err);
  return Response.json({ error: body }, { status: statusFor(body.code), headers: NO_STORE });
}

export function authFail(code: string, status: number, message: string): Response {
  return Response.json({ error: { code, message, status } }, { status, headers: NO_STORE });
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (request.method === 'GET' || request.method === 'HEAD') return {};
  const text = await request.text();
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function bearer(request: Request): string | null {
  const h = request.headers.get('Authorization') ?? '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() || null : null;
}
