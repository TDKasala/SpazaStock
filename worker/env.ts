/** Bindings and secrets of the SpazaStock Worker (see wrangler.jsonc). */
export interface Env {
  /** Static front end built by Vite into dist/. */
  ASSETS: Fetcher;
  /** https://<project-ref>.supabase.co, a plain var while the database is still on Supabase. */
  SUPABASE_URL: string;
  /** Public anon / sb_publishable_ key: `wrangler secret put SUPABASE_ANON_KEY`. */
  SUPABASE_ANON_KEY: string;
  /** Bypasses RLS. Only ever a Worker secret: `wrangler secret put SUPABASE_SERVICE_ROLE_KEY`. */
  SUPABASE_SERVICE_ROLE_KEY: string;
}
