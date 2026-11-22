/** A D1-shaped wrapper over node:sqlite, so D1 code runs under plain Vitest. */
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { D1Like } from '../../../worker/db/d1';

type Bound = { query: string; values: unknown[] };

export function nodeD1(db: DatabaseSync): D1Like & { db: DatabaseSync } {
  const exec = (b: Bound) => db.prepare(b.query);
  const values = (b: Bound) => b.values.map((v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v)) as never[];
  const make = (query: string) => ({
    bind(...v: unknown[]) {
      const b: Bound = { query, values: v };
      return {
        __bound: b,
        async all<T>() {
          return { results: exec(b).all(...values(b)).map((r) => ({ ...r })) as T[] };
        },
        async first<T>() {
          const r = exec(b).get(...values(b));
          return (r ? { ...r } : null) as T | null;
        },
        async run() {
          return { meta: { changes: Number(exec(b).run(...values(b)).changes) } };
        },
      };
    },
  });
  return {
    db,
    prepare: make,
    async batch(statements: unknown[]) {
      db.exec('BEGIN');
      try {
        const out = [];
        for (const s of statements as { __bound: Bound }[]) out.push(exec(s.__bound).run(...values(s.__bound)));
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  };
}

const MIGRATIONS = join(import.meta.dirname, '..', '..', '..', 'migrations', 'd1');

/** A fresh D1 with every migration in migrations/d1 applied, foreign keys on (as on D1). */
export function freshD1(): D1Like & { db: DatabaseSync } {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
  }
  return nodeD1(db);
}
