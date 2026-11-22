// SpazaStock Worker: serves the Vite PWA from static assets and the server API under /api.
//
// wrangler.jsonc sends only /api/* and /assets/* through this code (run_worker_first); every
// other path is answered by the assets layer, with single-page-application fallback to
// index.html and the response headers from public/_headers. That replaces vercel.json.
//
//   /api/auth/*          sign-up, codes, passwords, sessions (worker/auth)
//   /api/rpc/:name       the app's database functions (worker/shop in each shop's Durable
//                        Object, worker/d1 on D1)
//   /api/table           the app's few direct table reads/writes, with their RLS checks
//   /api/images/*        product pictures in R2
//   /api/product-lookup  Smart Product Scan

import type { Env } from './env';
import { authFor, handleAuth } from './api/authRoutes';
import { handleRpc, type Caller } from './api/rpc';
import { handleTable } from './api/table';
import { handleImages } from './api/images';
import { readJson } from './api/http';
import { handleProductLookup } from './productLookup';
import { handleMigrate } from './api/migrate';
import { runScheduled } from './cron';

export { ShopObject } from './shop/ShopObject';

async function callerFor(request: Request, env: Env): Promise<Caller | null> {
  const header = request.headers.get('Authorization') ?? '';
  if (!header.startsWith('Bearer ')) return null;
  const session = await authFor(env).userForToken(header.slice(7).trim());
  // A reset-code session may only change the password.
  if (!session || session.claims.recovery) return null;
  return { userId: session.user.id, email: session.user.email };
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.startsWith('/api/auth/')) return handleAuth(request, env, path);

    if (path.startsWith('/api/rpc/') && request.method === 'POST') {
      const name = decodeURIComponent(path.slice('/api/rpc/'.length));
      return handleRpc(env, name, await readJson(request), await callerFor(request, env));
    }

    if (path === '/api/table' && request.method === 'POST') {
      return handleTable(env, (await readJson(request)) as never, await callerFor(request, env));
    }

    if (path.startsWith('/api/images/')) return handleImages(request, env, path.slice('/api/images/'.length), await callerFor(request, env));

    if (path === '/api/product-lookup') return handleProductLookup(request, env);

    // One-time data import at cutover; answers 404 unless the IMPORT_TOKEN secret is set.
    if (path.startsWith('/api/migrate/')) return handleMigrate(request, env, path);

    if (path.startsWith('/api/')) {
      return Response.json({ error: 'Not found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
    }

    if (path.startsWith('/assets/')) {
      // Hashed build files. A name from an older deploy must 404, not fall back to index.html,
      // or the browser caches HTML as a script for a year (see the /assets/* rule in _headers).
      const asset = await env.ASSETS.fetch(request);
      if (asset.headers.get('Content-Type')?.startsWith('text/html')) {
        return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
      }
      return asset;
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env, ctx): Promise<void> {
    ctx.waitUntil(runScheduled(controller.cron, env));
  },
} satisfies ExportedHandler<Env>;
