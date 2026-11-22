import type { SqlRow, SqlValue, SyncSql } from './sql';

/** Durable Object SQLite storage. */
export function durableObjectSql(storage: DurableObjectStorage): SyncSql {
  return {
    all<T extends SqlRow>(query: string, ...params: SqlValue[]) {
      return storage.sql.exec(query, ...params).toArray() as unknown as T[];
    },
    run(query: string, ...params: SqlValue[]) {
      return storage.sql.exec(query, ...params).rowsWritten;
    },
    transaction<T>(fn: () => T): T {
      return storage.transactionSync(fn);
    },
  };
}
