/**
 * The app's few direct table reads and writes (supabase.from(...)), each with the check its
 * Postgres row-level-security policy made:
 *   - delta pull of shop tables                     any active member of the shop
 *   - products by id                                any active member
 *   - stock_discrepancies.resolved_at update        owners and managers
 *   - membership_events, newest first               owners
 *   - profiles: read own/co-members', update own    the user
 */
import { all, first, run } from '../db/d1';
import { DbError, forbidden } from '../db/errors';
import { toApiRow, toApiRows } from '../db/rows';
import type { Env } from '../env';
import { membership } from '../d1/common';
import { fail, ok } from './http';
import { shopStub, type Caller } from './rpc';

type Filters = Record<string, unknown>;

interface TableRequest {
  table: string;
  op: 'select' | 'update';
  /** Equality filters (.eq). */
  eq?: Filters;
  /** updated_at lower bound for the delta pull (.gt('updated_at', since)). */
  gt?: Filters;
  values?: Record<string, unknown>;
  offset?: number;
  limit?: number;
}

const str = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : null);

async function requireMember(env: Env, shopId: string | null, caller: Caller, roles?: string[]) {
  const m = shopId ? await membership(env.DB, shopId, caller.userId) : null;
  if (!m || (roles && !roles.includes(m.role))) throw forbidden();
  return m;
}

export async function handleTable(env: Env, req: TableRequest, caller: Caller | null): Promise<Response> {
  try {
    if (!caller) throw new DbError('42501', `permission denied for table ${req.table}`);
    const eq = req.eq ?? {};

    if (req.op === 'select' && req.gt && 'updated_at' in req.gt) {
      const shopId = str(eq.shop_id);
      await requireMember(env, shopId, caller);
      return ok(await shopStub(env, shopId!).pull(req.table, String(req.gt.updated_at), Number(req.offset ?? 0), Number(req.limit ?? 500)));
    }

    switch (`${req.op} ${req.table}`) {
      case 'select products': {
        const shopId = str(eq.shop_id);
        await requireMember(env, shopId, caller);
        return ok(await shopStub(env, shopId!).select('products', { id: str(eq.id) }, 1));
      }
      case 'update stock_discrepancies': {
        // The app sends only the id; the row is in one of the caller's owner/manager shops.
        const id = str(eq.id);
        const resolvedAt = req.values?.resolved_at == null ? null : new Date(String(req.values.resolved_at)).toISOString();
        const shops = await all<{ shop_id: string; status: string }>(
          env.DB,
          `SELECT m.shop_id, s.status FROM shop_members m JOIN shops s ON s.id = m.shop_id
            WHERE m.user_id = ? AND m.status = 'active' AND m.role IN ('owner', 'manager')`,
          caller.userId
        );
        for (const shop of shops) {
          const rows = await shopStub(env, shop.shop_id).select('stock_discrepancies', { id }, 1);
          if (!rows.length) continue;
          if (shop.status !== 'active') throw new DbError('SP001', 'This shop is suspended. Changes stay on this phone until it is reactivated.');
          return ok(await shopStub(env, shop.shop_id).resolveDiscrepancy(id!, resolvedAt));
        }
        return ok([]);
      }
      case 'select membership_events': {
        const shopId = str(eq.shop_id);
        await requireMember(env, shopId, caller, ['owner']);
        const limit = Math.max(1, Math.min(Number(req.limit ?? 50), 500));
        return ok(
          toApiRows(
            'membership_events',
            await all(env.DB, 'SELECT * FROM membership_events WHERE shop_id = ? ORDER BY created_at DESC LIMIT ?', shopId, limit)
          )
        );
      }
      case 'select profiles': {
        const id = str(eq.id);
        const visible =
          id === caller.userId ||
          (await first(
            env.DB,
            `SELECT 1 AS x FROM shop_members a JOIN shop_members b ON b.shop_id = a.shop_id
              WHERE a.user_id = ? AND a.status = 'active' AND b.user_id = ? AND b.status = 'active'`,
            caller.userId,
            id
          ));
        if (!visible) return ok([]);
        return ok([toApiRow('profiles', await first(env.DB, 'SELECT * FROM profiles WHERE id = ?', id))].filter(Boolean));
      }
      case 'update profiles': {
        if (str(eq.id) !== caller.userId) return ok([]);
        const name = req.values?.display_name;
        const clean = name == null ? null : String(name).trim() || null;
        if (clean !== null && [...clean].length > 80) throw new DbError('23514', 'Display name is too long.');
        await run(env.DB, 'UPDATE profiles SET display_name = ? WHERE id = ?', clean, caller.userId);
        return ok([toApiRow('profiles', await first(env.DB, 'SELECT * FROM profiles WHERE id = ?', caller.userId))]);
      }
    }
    throw new DbError('42501', `permission denied for table ${req.table}`);
  } catch (err) {
    return fail(err);
  }
}
