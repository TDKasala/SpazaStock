// @vitest-environment node
/**
 * The browser bundle must only ever contain the public (anon / publishable) Supabase key.
 * Service-role and secret keys bypass RLS and belong in server-side secrets only.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const TEXT_FILE = /\.(ts|tsx|js|mjs|cjs|jsx|json|html|css|webmanifest|txt|map)$/;

function filesUnder(dir: string, skip: (path: string) => boolean = () => false): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (skip(path)) return [];
    return statSync(path).isDirectory() ? filesUnder(path, skip) : TEXT_FILE.test(name) ? [path] : [];
  });
}

/** Returns a reason when the text contains a privileged Supabase credential. */
function findPrivilegedKey(text: string): string | null {
  if (/sb_secret_[A-Za-z0-9_-]{8,}/.test(text)) return 'sb_secret_ key';
  for (const [token] of text.matchAll(/eyJ[\w-]+\.(eyJ[\w-]+)\.[\w-]+/g)) {
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
      if (payload?.role === 'service_role') return 'service_role JWT';
    } catch {
      // Not a JWT.
    }
  }
  if (/\bservice_role\b/.test(text)) return 'service_role reference';
  return null;
}

describe('privileged credentials', () => {
  it('detects secret keys and service-role JWTs', () => {
    const payload = Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url');
    expect(findPrivilegedKey(`key = "eyJhbGciOiJIUzI1NiJ9.${payload}.c2lnbmF0dXJl"`)).toBe('service_role JWT');
    expect(findPrivilegedKey('SUPABASE_KEY=sb_secret_abcdefghijklmnop')).toBe('sb_secret_ key');
    expect(findPrivilegedKey('VITE_SUPABASE_ANON_KEY="sb_publishable_abcdefghijk"')).toBeNull();
  });

  it('never appear in app source, public assets or the built bundle', () => {
    const testDir = join(ROOT, 'src', 'test');
    const files = [
      ...filesUnder(join(ROOT, 'src'), (path) => path.startsWith(testDir)),
      ...filesUnder(join(ROOT, 'public')),
      ...filesUnder(join(ROOT, 'dist')),
      join(ROOT, 'index.html'),
      join(ROOT, '.env.example'),
    ];
    expect(files.length).toBeGreaterThan(10);

    const leaks = files.flatMap((file) => {
      const reason = findPrivilegedKey(readFileSync(file, 'utf8'));
      return reason ? [`${relative(ROOT, file)}: ${reason}`] : [];
    });
    expect(leaks).toEqual([]);
  });
});
