import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { en } from '../locales/en';
import { zu } from '../locales/zu';
import { interpolate } from '../context/LanguageContext';

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
const zuFlat = flatten(zu);

describe('translations', () => {
  it('has exactly the same keys in English and isiZulu, at every depth', () => {
    expect([...zuFlat.keys()].sort()).toEqual([...enFlat.keys()].sort());
  });

  it('has no empty translations', () => {
    for (const [key, value] of [...enFlat, ...zuFlat]) {
      if (Array.isArray(value)) expect(value.length, key).toBeGreaterThan(0);
      else expect(String(value).trim(), key).not.toBe('');
    }
  });

  it('uses the same {{placeholders}} in both languages', () => {
    for (const [key, value] of enFlat) {
      expect(placeholders(zuFlat.get(key)), key).toEqual(placeholders(value));
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
