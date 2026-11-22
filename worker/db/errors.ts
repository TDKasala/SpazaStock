/**
 * Errors with the same codes Postgres raised, so the app's error handling keeps working:
 *   22023 invalid input, 42501 not allowed, 23505 already exists, P0002 not found,
 *   P0001 other business rule, SP001 shop suspended, SP002 plan limit.
 * The sync engine treats codes starting 22/23/42/P0 as permanent (never retried).
 */
export class DbError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'DbError';
  }
}

export const invalid = (message: string) => new DbError('22023', message);
export const forbidden = (message = 'You do not have access to this shop.') => new DbError('42501', message);
export const notFound = (message: string) => new DbError('P0002', message);
export const conflict = (message: string) => new DbError('23505', message);
export const businessRule = (message: string) => new DbError('P0001', message);
export const suspended = () =>
  new DbError('SP001', 'This shop is suspended. Changes stay on this phone until it is reactivated.');
export const planLimit = (message: string) => new DbError('SP002', message);

/** SQLite constraint failures mapped onto the Postgres codes the app expects. */
export function fromSqliteError(err: unknown): DbError {
  if (err instanceof DbError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (/UNIQUE constraint failed/i.test(message)) return new DbError('23505', message);
  if (/CHECK constraint failed|NOT NULL constraint failed|FOREIGN KEY constraint failed/i.test(message)) {
    return new DbError('23514', message);
  }
  return new DbError('XX000', message);
}

export interface ApiErrorBody {
  code: string;
  message: string;
}

export function errorBody(err: unknown): ApiErrorBody {
  const e = fromSqliteError(err);
  // Internal errors keep their detail in logs, not in the response.
  return e.code === 'XX000' ? { code: 'XX000', message: 'Something went wrong.' } : { code: e.code, message: e.message };
}
