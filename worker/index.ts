// SpazaStock Worker: serves the Vite PWA from static assets and the server API under /api.
//
// wrangler.jsonc sends only /api/* and /assets/* through this code (run_worker_first); every other path is
// answered by the assets layer, with single-page-application fallback to index.html and the
// response headers from public/_headers. That replaces vercel.json.

import type { Env } from './env';
import { handleProductLookup } from './productLookup';

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/product-lookup') {
      return handleProductLookup(request, env);
    }

    if (url.pathname.startsWith('/api/')) {
      return Response.json({ error: 'Not found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
    }

    if (url.pathname.startsWith('/assets/')) {
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
} satisfies ExportedHandler<Env>;
