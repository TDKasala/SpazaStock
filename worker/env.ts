/** Bindings and secrets of the SpazaStock Worker (see wrangler.jsonc). */
import type { ShopObject } from './shop/ShopObject';

export interface Env {
  /** Static front end built by Vite into dist/. */
  ASSETS: Fetcher;
  /** Shared D1 database (migrations/d1). */
  DB: D1Database;
  /** One Durable Object per shop: that shop's ledger. */
  SHOP: DurableObjectNamespace<ShopObject>;
  /** Product pictures (keys as in Supabase Storage: <shop-id>/<hash>.webp, catalog/<id>.webp). */
  IMAGES: R2Bucket;
  /** Cloudflare Email Sending, for sign-in codes. Optional in local development. */
  EMAIL?: SendEmail;
  /** Sender address on a domain onboarded to Email Sending, e.g. no-reply@spazastock.co.za. */
  EMAIL_FROM?: string;
  /** Signs access tokens. `wrangler secret put AUTH_SECRET` (32+ random characters). */
  AUTH_SECRET: string;
  /** Web Push keys, copied unchanged from Supabase Vault so existing subscriptions keep working. */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  /** Set only during the cutover import (`wrangler secret put IMPORT_TOKEN`), then deleted. */
  IMPORT_TOKEN?: string;
}
