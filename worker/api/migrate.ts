/**
 * /api/migrate/*: the one-time data import at cutover (scripts/migrate-data/import.ts). Only
 * active while the IMPORT_TOKEN secret is set; delete the secret after the cutover and every
 * route here answers 404.
 *
 *   POST /api/migrate/shop/:id        import a shop bundle into its Durable Object (?replace=1)
 *   GET  /api/migrate/shop/:id/stats  that shop's row counts and totals, for verification
 *   PUT  /api/migrate/image/<key>     store a product picture in R2 under its Supabase key
 */
import type { Env } from '../env';
import { timingSafeEqual } from '../auth/crypto';
import { fail } from './http';
import { shopStub } from './rpc';
import type { ShopBundle } from '../shop/ShopObject';

const notFound = () => Response.json({ error: 'Not found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });

export async function handleMigrate(request: Request, env: Env & { IMPORT_TOKEN?: string }, path: string): Promise<Response> {
  const token = env.IMPORT_TOKEN;
  const given = (request.headers.get('Authorization') ?? '').replace(/^Bearer /, '');
  if (!token || token.length < 32 || !timingSafeEqual(given, token)) return notFound();

  const shop = /^\/api\/migrate\/shop\/([0-9a-f-]{36})(\/stats)?$/.exec(path);
  if (shop) {
    const stub = shopStub(env, shop[1]);
    try {
      if (request.method === 'GET' && shop[2]) return Response.json(await stub.stats());
      if (request.method === 'POST' && !shop[2]) {
        const bundle = (await request.json()) as ShopBundle;
        if (bundle.shopId !== shop[1]) return Response.json({ error: 'Bundle is for another shop.' }, { status: 400 });
        const replace = new URL(request.url).searchParams.get('replace') === '1';
        const result = await stub.importBundle(bundle, replace);
        if ('error' in result) return Response.json({ error: result.error }, { status: result.error.code === '23505' ? 409 : 400 });
        return Response.json(result.counts);
      }
    } catch (err) {
      return fail(err);
    }
  }

  if (path.startsWith('/api/migrate/image/') && request.method === 'PUT') {
    const key = decodeURIComponent(path.slice('/api/migrate/image/'.length));
    await env.IMAGES.put(key, await request.arrayBuffer(), {
      httpMetadata: { contentType: request.headers.get('Content-Type') ?? 'image/webp', cacheControl: 'max-age=31536000' },
    });
    return Response.json({ key });
  }
  return notFound();
}
