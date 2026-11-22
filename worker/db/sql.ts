/**
 * The small synchronous SQL surface the shop ledger code is written against. Two implementations:
 * the shop Durable Object's SQLite (ctx.storage.sql), and node:sqlite in tests. Both run inside a
 * single-threaded owner, so a function that never awaits sees and changes a consistent database.
 */
export type SqlValue = string | number | null;
export type SqlRow = Record<string, SqlValue>;

export interface SyncSql {
  all<T extends SqlRow = SqlRow>(query: string, ...params: SqlValue[]): T[];
  /** Runs a statement and returns how many rows it changed. */
  run(query: string, ...params: SqlValue[]): number;
  /** Runs fn atomically: everything it wrote is undone if it throws. */
  transaction<T>(fn: () => T): T;
}

export function one<T extends SqlRow = SqlRow>(sql: SyncSql, query: string, ...params: SqlValue[]): T | null {
  return sql.all<T>(query, ...params)[0] ?? null;
}
