import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { en } from '../locales/en';
import { zu } from '../locales/zu';
import { am } from '../locales/am';
import { so } from '../locales/so';
import { interpolate } from '../context/LanguageContext';
import { detectLocale, intlTag, isLocale, LANGUAGES, type Locale } from '../lib/languages';
import { formatShortDate } from '../lib/dates';

type Tree = Record<string, unknown>;

/** Flattens a dictionary to `section.key` paths with their values (arrays count as leaves). */
function flatten(tree: Tree, prefix = ''): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [k, v] of flatten(value as Tree, path)) out.set(k, v);
    } else {
      out.set(path, value);
    }
  }
  return out;
}

function placeholders(value: unknown): string[] {
  return [...String(value).matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === 'test' ? [] : sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

const enFlat = flatten(en);
const others = { zu, am, so } as const;
const otherFlat = Object.entries(others).map(([code, dict]) => [code, flatten(dict)] as const);

/** Strings that are deliberately the same in every language. */
const SAME_EVERYWHERE = new Set(['common.appName', 'team.shareWhatsApp', 'product.barcode']);

describe('translations', () => {
  it('registers every dictionary under a supported language code', () => {
    expect(LANGUAGES.map((l) => l.code).sort()).toEqual(['en', ...Object.keys(others)].sort());
  });

  it.each(otherFlat)('%s has exactly the same keys as English, at every depth', (_code, flat) => {
    expect([...flat.keys()].sort()).toEqual([...enFlat.keys()].sort());
  });

  it('has no empty translations', () => {
    for (const [key, value] of [...enFlat, ...otherFlat.flatMap(([, flat]) => [...flat])]) {
      if (Array.isArray(value)) expect(value.length, key).toBeGreaterThan(0);
      else expect(String(value).trim(), key).not.toBe('');
    }
  });

  it.each(otherFlat)('%s uses the same {{placeholders}} as English', (_code, flat) => {
    for (const [key, value] of enFlat) {
      expect(placeholders(flat.get(key)), key).toEqual(placeholders(value));
    }
  });

  it.each(otherFlat)('%s is translated, not copied from English', (_code, flat) => {
    const copied = [...enFlat].filter(
      ([key, value]) => !SAME_EVERYWHERE.has(key) && /[a-z]{4,}/i.test(String(value)) && flat.get(key) === value
    );
    // A few short labels (e.g. product names in examples) may legitimately match.
    expect(copied.length, copied.map(([key]) => key).join(', ')).toBeLessThanOrEqual(5);
  });

  it('writes Amharic in Ethiopic script', () => {
    const ethiopic = /[\u1200-\u137F]/;
    for (const key of ['common.tagline', 'auth.signIn', 'landing.headline', 'navigation.sales', 'sales.sell']) {
      expect(ethiopic.test(String(flatten(am).get(key))), key).toBe(true);
    }
  });

  it('defines every key the app looks up with t()', () => {
    const used = new Set<string>();
    for (const file of sourceFiles(join(__dirname, '..'))) {
      for (const match of readFileSync(file, 'utf8').matchAll(/\bt\('([\w.]+)'/g)) used.add(match[1]);
    }
    expect(used.size).toBeGreaterThan(50);
    const missing = [...used].filter((key) => typeof enFlat.get(key) !== 'string');
    expect(missing).toEqual([]);
  });

  it('interpolates variables and leaves unknown placeholders alone', () => {
    expect(interpolate('Sold {{count}} of {{name}}', { count: 2, name: 'Bread' })).toBe('Sold 2 of Bread');
    expect(interpolate('Hi {{name}}', {})).toBe('Hi {{name}}');
  });

  it('keeps the dashboard action names', () => {
    expect(en.dashboard.actions.quickSale.title).toBe('Quick Sale');
    expect(zu.dashboard.actions.quickSale.title).toBe('Thengisa Masinyane');
  });
});

describe('language choice', () => {
  it('recognises only supported codes', () => {
    for (const code of ['en', 'zu', 'am', 'so']) expect(isLocale(code)).toBe(true);
    for (const value of ['fr', 'EN', '', null, undefined, 42]) expect(isLocale(value)).toBe(false);
  });

  it("picks the phone's first supported language, else English", () => {
    expect(detectLocale(['so-SO', 'en'])).toBe('so');
    expect(detectLocale(['am'])).toBe('am');
    expect(detectLocale(['AM-et'])).toBe('am');
    expect(detectLocale(['fr-FR', 'zu_ZA'])).toBe('zu');
    expect(detectLocale(['fr-FR'])).toBe('en');
    expect(detectLocale([])).toBe('en');
  });

  it('formats dates for every language without failing', () => {
    const codes: Locale[] = ['en', 'zu', 'am', 'so'];
    for (const code of codes) {
      expect(intlTag(code)).toMatch(/^[a-z]{2}-[A-Z]{2}$/);
      expect(formatShortDate('2026-10-21T10:00:00Z', code)).toMatch(/2026/);
    }
    expect(formatShortDate('2026-10-21T10:00:00Z', 'xx')).toMatch(/2026/);
    expect(formatShortDate('not a date', 'am')).toBe('');
  });
});
