/**
 * Loads a LoadPlan into throwaway in-memory SQLite databases built from the generated schemas,
 * with foreign keys enforced: one for D1, one per shop like its Durable Object. Proves that the
 * converted production data satisfies every STRICT type, CHECK, UNIQUE and foreign key before
 * anything is sent to Cloudflare.
 */
import { DatabaseSync } from 'node:sqlite';
import { insertStatement, type LoadPlan } from './transform.ts';

export interface RehearsalResult {
  ok: boolean;
  errors: string[];
  d1Rows: Record<string, number>;
  shopRows: Record<string, number>;
}

function foreignKeyProblems(db: DatabaseSync, label: string): string[] {
  const rows = db.prepare('PRAGMA foreign_key_check').all() as { table: string; rowid: number; parent: string }[];
  return rows.map((r) => `${label}: ${r.table} row ${r.rowid} points at a missing ${r.parent}`);
}

function counts(db: DatabaseSync, into: Record<string, number>): void {
  const tables = db
    .prepare(`select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name`)
    .all() as { name: string }[];
  for (const { name } of tables) {
    const { n } = db.prepare(`select count(*) as n from ${name}`).get() as { n: number };
    into[name] = (into[name] ?? 0) + n;
  }
}

/** Commits, or rolls back and reports when this database already has errors or COMMIT fails. */
function finish(db: DatabaseSync, label: string, hadErrors: boolean, errors: string[]): void {
  if (hadErrors) {
    db.exec('ROLLBACK;');
    return;
  }
  try {
    db.exec('COMMIT;');
  } catch (err) {
    errors.push(`${label}: ${(err as Error).message} at commit`);
    db.exec('ROLLBACK;');
  }
}

export function rehearse(plan: LoadPlan, d1Schema: string, shopSchema: string): RehearsalResult {
  const errors: string[] = [];
  const d1Rows: Record<string, number> = {};
  const shopRows: Record<string, number> = {};

  const d1 = new DatabaseSync(':memory:');
  try {
    d1.exec('PRAGMA foreign_keys = ON;');
    d1.exec(d1Schema);
    d1.exec('BEGIN;');
    const before = errors.length;
    for (const statement of plan.d1Statements) {
      try {
        d1.exec(statement);
      } catch (err) {
        errors.push(`D1: ${(err as Error).message} in ${statement.slice(0, 160)}`);
      }
    }
    errors.push(...foreignKeyProblems(d1, 'D1'));
    finish(d1, 'D1', errors.length > before, errors);
    counts(d1, d1Rows);
  } finally {
    d1.close();
  }

  for (const bundle of plan.shops) {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('PRAGMA foreign_keys = ON;');
      db.exec(shopSchema);
      db.exec('BEGIN;');
      // Same as the Durable Object import: all of a shop in one transaction, checked at the end.
      db.exec('PRAGMA defer_foreign_keys = ON;');
      const before = errors.length;
      for (const { table, rows } of bundle.tables) {
        for (const row of rows) {
          try {
            db.exec(insertStatement(table, row));
          } catch (err) {
            errors.push(`shop ${bundle.shopId}: ${(err as Error).message} in ${table} ${String(row.id ?? '')}`);
          }
        }
      }
      errors.push(...foreignKeyProblems(db, `shop ${bundle.shopId}`));
      finish(db, `shop ${bundle.shopId}`, errors.length > before, errors);
      counts(db, shopRows);
    } finally {
      db.close();
    }
  }

  return { ok: errors.length === 0, errors, d1Rows, shopRows };
}
