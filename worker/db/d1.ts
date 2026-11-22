/** Small helpers over D1 (async). */
import type { SqlRow, SqlValue } from './sql';

export interface D1Like {
  prepare(query: string): {
    bind(...values: unknown[]): {
      all<T = SqlRow>(): Promise<{ results: T[] }>;
      first<T = SqlRow>(): Promise<T | null>;
      run(): Promise<{ meta: { changes: number } }>;
    };
  };
  batch(statements: unknown[]): Promise<unknown[]>;
}

export async function all<T = SqlRow>(db: D1Like, query: string, ...params: SqlValue[]): Promise<T[]> {
  return (await db.prepare(query).bind(...params).all<T>()).results;
}

export async function first<T = SqlRow>(db: D1Like, query: string, ...params: SqlValue[]): Promise<T | null> {
  return db.prepare(query).bind(...params).first<T>();
}

export async function run(db: D1Like, query: string, ...params: SqlValue[]): Promise<number> {
  return (await db.prepare(query).bind(...params).run()).meta.changes;
}

/** Runs statements atomically (D1 batch is one transaction). */
export async function batch(db: D1Like, statements: [string, ...SqlValue[]][]): Promise<void> {
  await db.batch(statements.map(([q, ...p]) => db.prepare(q).bind(...p)));
}

export async function insertRow(db: D1Like, table: string, row: Record<string, SqlValue>): Promise<void> {
  const cols = Object.keys(row);
  await run(db, `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...cols.map((c) => row[c]));
}

export function insertStatement(table: string, row: Record<string, SqlValue>): [string, ...SqlValue[]] {
  const cols = Object.keys(row);
  return [`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...cols.map((c) => row[c])];
}
