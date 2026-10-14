import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { adminEn } from '../admin/locales/en';
import { adminZu } from '../admin/locales/zu';
import { adminLocale, hasAdminKey, translateAdmin } from '../admin/i18n';

type Tree = Record<string, unknown>;

function flatten(tree: Tree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object') {
      for (const [k, v] of flatten(value as Tree, path)) out.set(k, v);
    } else {
      out.set(path, String(value));
    }
  }
  return out;
}

function placeholders(value: string | undefined): string[] {
  return [...String(value).matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
}

function adminSources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === 'locales' ? [] : adminSources(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

const en = flatten(adminEn);
const zu = flatten(adminZu);
const sources = adminSources(join(__dirname, '..', 'admin')).map((file) => readFileSync(file, 'utf8'));

describe('admin translations', () => {
  it('has the same keys in English and isiZulu', () => {
    expect([...zu.keys()].sort()).toEqual([...en.keys()].sort());
  });

  it('has no empty strings and keeps every placeholder', () => {
    for (const [key, value] of en) {
      expect(value.trim(), key).not.toBe('');
      expect(zu.get(key)?.trim(), key).not.toBe('');
      expect(placeholders(zu.get(key)), key).toEqual(placeholders(value));
    }
  });

  it('is translated into isiZulu rather than copied', () => {
    const copied = [...en].filter(([key, value]) => /[a-z]{5,}/i.test(value) && zu.get(key) === value).map(([key]) => key);
    expect(copied.length, copied.join(', ')).toBeLessThanOrEqual(Math.ceil(en.size * 0.05));
  });

  it("defines every key the admin screens look up with at()", () => {
    const used = new Set<string>();
    for (const source of sources) {
      for (const match of source.matchAll(/\bat\(\s*'([\w.]+)'/g)) used.add(match[1]);
    }
    expect(used.size).toBeGreaterThan(100);
    expect([...used].filter((key) => !hasAdminKey(key))).toEqual([]);
  });

  it('has a group for every label() lookup', () => {
    const groups = new Set<string>();
    for (const source of sources) {
      for (const match of source.matchAll(/\blabel\(\s*'([\w.]+)'/g)) groups.add(match[1]);
    }
    expect(groups.size).toBeGreaterThan(0);
    for (const group of groups) {
      expect([...en.keys()].some((key) => key.startsWith(`${group}.`)), group).toBe(true);
    }
  });

  it('labels every audit action the database records', () => {
    const migration = readFileSync(
      join(__dirname, '..', '..', 'supabase', 'migrations', '20261014191106_platform_admin_functions.sql'),
      'utf8'
    );
    const actions = new Set<string>();
    for (const match of migration.matchAll(/(?<!permission\()'((?:tenant|admin|billing|plan|feature)\.[a-z_]+)'/g)) {
      actions.add(match[1]);
    }
    for (const match of migration.matchAll(/platform_denied\('([a-z_.]+)'/g)) actions.add(match[1]);
    expect(actions.size).toBeGreaterThan(20);
    const missing = [...actions].filter((action) => !hasAdminKey(`actions.${action.replace(/\./g, '_')}`));
    expect(missing).toEqual([]);
  });

  it('falls back to English for other shop languages, then to the key', () => {
    expect(adminLocale('zu')).toBe('zu');
    expect(adminLocale('am')).toBe('en');
    expect(adminLocale('so')).toBe('en');
    const [key, value] = [...en].find(([, v]) => !v.includes('{{'))!;
    expect(translateAdmin('en', key)).toBe(value);
    expect(translateAdmin('zu', 'no.such.key')).toBe('no.such.key');
  });
});
