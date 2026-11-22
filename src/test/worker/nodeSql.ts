/** node:sqlite implementation of the Worker's SyncSql, so shop code runs under plain Vitest. */
import { DatabaseSync } from 'node:sqlite';
import type { SqlRow, SqlValue, SyncSql } from '../../../worker/db/sql';

export function nodeSql(db: DatabaseSync): SyncSql {
  let depth = 0;
  return {
    all<T extends SqlRow>(query: string, ...params: SqlValue[]) {
      return db.prepare(query).all(...params).map((r) => ({ ...r })) as T[];
    },
    run(query: string, ...params: SqlValue[]) {
      return Number(db.prepare(query).run(...params).changes);
    },
    transaction<T>(fn: () => T): T {
      const name = `sp${depth++}`;
      db.exec(`SAVEPOINT ${name}`);
      try {
        const result = fn();
        db.exec(`RELEASE ${name}`);
        return result;
      } catch (err) {
        db.exec(`ROLLBACK TO ${name}`);
        db.exec(`RELEASE ${name}`);
        throw err;
      } finally {
        depth--;
      }
    },
  };
}

export function openShopDatabase(schema: string): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  return db;
}
