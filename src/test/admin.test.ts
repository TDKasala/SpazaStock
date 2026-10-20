import { describe, it, expect } from 'vitest';
import {
  ADMIN_SECTIONS,
  canAdmin,
  canOpenSection,
  isPlatformRole,
  PLATFORM_ROLE_PERMISSIONS,
  PLATFORM_ROLES,
  type AdminSection,
  type PlatformRole,
} from '../admin/permissions';
import { guardStateFrom } from '../admin/AdminGuard';
import { AdminError, adminErrorMessage, errorFromPostgrest, unwrapAdminResult } from '../admin/api';
import { adminHref, parseAdminLocation } from '../admin/router';
import { csvCell, toCsv } from '../admin/csv';
import { defaultBucket, MAX_RANGE_DAYS, resolveRange } from '../admin/range';
import { platformDayStart, toPlatformDay } from '../admin/format';
import { parsePriceCents } from '../admin/pages/BillingPage';
import { confirmNameMatches, reasonIssue, REASON_MAX, REASON_MIN } from '../admin/components/ReasonConfirmDialog';
import { translateAdmin } from '../admin/i18n';

const SHOP_ID = '6f1c2a4e-1b2c-4d3e-8f90-123456789abc';

describe('admin permissions', () => {
  const sections = (role: PlatformRole) => ADMIN_SECTIONS.filter((s) => canOpenSection(role, s));

  it('opens only the sections each role can use', () => {
    expect(sections('superadmin')).toEqual([...ADMIN_SECTIONS]);
    expect(sections('support')).toEqual<AdminSection[]>(['overview', 'tenants', 'operations']);
    expect(sections('billing')).toEqual<AdminSection[]>(['overview', 'tenants', 'billing']);
    expect(sections('analyst')).toEqual<AdminSection[]>(['overview', 'analytics']);
  });

  it('gives no role and no unknown role anything', () => {
    for (const section of ADMIN_SECTIONS) {
      expect(canOpenSection(null, section)).toBe(false);
      expect(canOpenSection(undefined, section)).toBe(false);
    }
    expect(canAdmin(null, 'tenants.view')).toBe(false);
    for (const value of ['owner', 'SUPERADMIN', '', null, 1]) expect(isPlatformRole(value)).toBe(false);
    for (const role of PLATFORM_ROLES) expect(isPlatformRole(role)).toBe(true);
  });

  it('keeps destructive permissions with superadmins', () => {
    for (const permission of ['admins.manage', 'tenants.manage', 'tenants.export', 'plans.manage', 'audit.view'] as const) {
      const holders = PLATFORM_ROLES.filter((role) => canAdmin(role, permission));
      expect(holders, permission).toEqual(['superadmin']);
    }
    expect(PLATFORM_ROLE_PERMISSIONS.analyst).toEqual(['analytics.view']);
  });
});

describe('admin guard', () => {
  const whoami = (role: string | null, permissions: string[] = []) => ({ ok: true as const, role, email: 'a@example.com', permissions });

  it('waits, then lets only a server-confirmed role in', () => {
    expect(guardStateFrom(null, null)).toEqual({ kind: 'checking' });
    expect(guardStateFrom(whoami(null) as never, null)).toEqual({ kind: 'denied' });
    expect(guardStateFrom(whoami('owner') as never, null)).toEqual({ kind: 'denied' });
    expect(guardStateFrom(whoami('support', ['tenants.view', 'operations.view', 'made.up']) as never, null)).toEqual({
      kind: 'allowed',
      identity: { role: 'support', email: 'a@example.com', permissions: ['tenants.view', 'operations.view'] },
    });
  });

  it('only shows permissions both sides agree on', () => {
    const state = guardStateFrom(whoami('superadmin', ['tenants.view']) as never, null);
    expect(state.kind === 'allowed' && state.identity.permissions).toEqual(['tenants.view']);
  });

  it('tells offline apart from other failures', () => {
    expect(guardStateFrom(null, new AdminError('network'))).toEqual({ kind: 'offline' });
    expect(guardStateFrom(null, new AdminError('forbidden'))).toEqual({ kind: 'error' });
    expect(guardStateFrom(null, new Error('boom'))).toEqual({ kind: 'error' });
  });
});

describe('admin API errors', () => {
  it('maps database errors to what the screens can say', () => {
    expect(errorFromPostgrest({ code: '22023', message: 'Reason too short' })).toMatchObject({ kind: 'invalid', message: 'Reason too short' });
    expect(errorFromPostgrest({ code: '42501', message: 'permission denied for function x' }).kind).toBe('forbidden');
    expect(errorFromPostgrest({ code: '42501', message: 'permission denied for function x' }).message).not.toContain('function');
    expect(errorFromPostgrest({ message: 'TypeError: Failed to fetch' }).kind).toBe('network');
    expect(errorFromPostgrest({ code: '', message: '' }).kind).toBe('network');
    expect(errorFromPostgrest({ code: 'XX000', message: 'internal' }).kind).toBe('unknown');
  });

  it('turns audited refusals into errors and passes results through', () => {
    expect(unwrapAdminResult({ ok: true, rows: [] })).toEqual({ ok: true, rows: [] });
    expect(() => unwrapAdminResult({ ok: false, code: 'forbidden' })).toThrow(expect.objectContaining({ kind: 'forbidden' }));
    expect(() => unwrapAdminResult({ ok: false, code: 'not_found' })).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => unwrapAdminResult({ ok: false, code: 'conflict' })).toThrow(expect.objectContaining({ kind: 'conflict' }));
    expect(() => unwrapAdminResult(null)).toThrow(expect.objectContaining({ kind: 'forbidden' }));
    expect(() => unwrapAdminResult({ rows: [] })).toThrow(expect.objectContaining({ kind: 'forbidden' }));
  });

  it('explains each error in the chosen language', () => {
    const at = (key: string, vars?: Record<string, string | number>) => translateAdmin('zu', key, vars);
    for (const kind of ['forbidden', 'not_found', 'conflict', 'network', 'unknown'] as const) {
      const message = adminErrorMessage(new AdminError(kind), at);
      expect(message).not.toMatch(/^errors\./);
    }
    expect(adminErrorMessage(new AdminError('invalid', 'Choose a plan'), at)).toContain('Choose a plan');
    expect(adminErrorMessage('weird', at)).toBe(at('errors.unknown'));
  });
});

describe('admin routes', () => {
  it('parses sections, tenant ids and filters from the address', () => {
    expect(parseAdminLocation('/admin', '')).toMatchObject({ section: 'overview', tenantId: null });
    expect(parseAdminLocation('/admin/', '')).toMatchObject({ section: 'overview', tenantId: null });
    expect(parseAdminLocation('/admin/audit', '?action=tenant.&offset=50').params.get('action')).toBe('tenant.');
    expect(parseAdminLocation(`/admin/tenants/${SHOP_ID.toUpperCase()}`, '')).toMatchObject({ section: 'tenants', tenantId: SHOP_ID });
    expect(parseAdminLocation('/admin/tenants/not-a-uuid', '')).toMatchObject({ section: 'tenants', tenantId: null });
    expect(parseAdminLocation(`/admin/billing/${SHOP_ID}`, '')).toMatchObject({ section: 'billing', tenantId: null, catalogId: null });
    expect(parseAdminLocation(`/admin/catalog/${SHOP_ID.toUpperCase()}`, '')).toMatchObject({
      section: 'catalog',
      tenantId: null,
      catalogId: SHOP_ID,
    });
    expect(parseAdminLocation('/admin/catalog/new', '').catalogId).toBe('new');
    expect(parseAdminLocation('/admin/catalog/not-a-uuid', '').catalogId).toBeNull();
    expect(parseAdminLocation('/admin/secret', '').section).toBe('overview');
  });

  it('builds links that round-trip, dropping empty filters', () => {
    expect(adminHref('overview')).toBe('/admin');
    expect(adminHref('tenants', { tenantId: SHOP_ID })).toBe(`/admin/tenants/${SHOP_ID}`);
    expect(adminHref('catalog', { catalogId: 'new' })).toBe('/admin/catalog/new');
    const href = adminHref('tenants', { params: { q: 'Thandi & Sons', status: 'suspended', plan: '', sort: null } });
    expect(href).toBe('/admin/tenants?q=Thandi+%26+Sons&status=suspended');
    const [path, search] = href.split('?');
    const parsed = parseAdminLocation(path, `?${search}`);
    expect(parsed.params.get('q')).toBe('Thandi & Sons');
    expect(parsed.params.has('plan')).toBe(false);
  });
});

describe('CSV export', () => {
  it('neutralises spreadsheet formulas typed into names and emails', () => {
    for (const value of ['=HYPERLINK("http://x")', '+27 82', '-1+1', '@SUM(A1)', '\tcmd', '\rcmd']) {
      expect(csvCell(value).replace(/^"/, '').startsWith("'"), value).toBe(true);
    }
    expect(csvCell('=1+1')).toBe("'=1+1");
  });

  it('quotes separators, quotes and line breaks, and keeps numbers as numbers', () => {
    expect(csvCell('Thandi, "the best"')).toBe('"Thandi, ""the best"""');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(12.5)).toBe('12.5');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(false)).toBe('false');
    expect(toCsv(['name', 'members'], [['A, B', 2], ['=x', 0]])).toBe('name,members\r\n"A, B",2\r\n\'=x,0');
  });
});

describe('admin date ranges', () => {
  const now = new Date('2026-10-14T10:00:00Z');

  it('resolves presets to a window ending now', () => {
    const range = resolveRange({ preset: '30d' }, now)!;
    expect(range.to).toEqual(now);
    expect((range.to.getTime() - range.from.getTime()) / 86_400_000).toBe(30);
  });

  it('treats custom days as whole South African days, end day included', () => {
    const range = resolveRange({ preset: 'custom', fromDay: '2026-10-01', toDay: '2026-10-01' }, now)!;
    expect(range.from.toISOString()).toBe('2026-09-30T22:00:00.000Z');
    expect(range.to.toISOString()).toBe('2026-10-01T22:00:00.000Z');
  });

  it('rejects reversed, incomplete, invalid and over-long custom ranges', () => {
    expect(resolveRange({ preset: 'custom', fromDay: '2026-10-02', toDay: '2026-10-01' }, now)).toBeNull();
    expect(resolveRange({ preset: 'custom', fromDay: '2026-10-02' }, now)).toBeNull();
    expect(resolveRange({ preset: 'custom', fromDay: 'yesterday', toDay: '2026-10-01' }, now)).toBeNull();
    expect(resolveRange({ preset: 'custom', fromDay: '2025-01-01', toDay: '2026-01-01' }, now)).not.toBeNull();
    expect(resolveRange({ preset: 'custom', fromDay: '2025-01-01', toDay: '2026-01-02' }, now)).toBeNull();
    expect(MAX_RANGE_DAYS).toBe(366);
  });

  it('picks a bucket size that keeps charts readable', () => {
    const days = (n: number) => new Date(now.getTime() - n * 86_400_000);
    expect(defaultBucket(days(30), now)).toBe('day');
    expect(defaultBucket(days(90), now)).toBe('week');
    expect(defaultBucket(days(365), now)).toBe('month');
  });

  it('converts between instants and South African calendar days', () => {
    expect(toPlatformDay(new Date('2026-10-13T22:30:00Z'))).toBe('2026-10-14');
    expect(toPlatformDay(new Date('2026-10-13T21:30:00Z'))).toBe('2026-10-13');
    expect(platformDayStart('2026-10-14').toISOString()).toBe('2026-10-13T22:00:00.000Z');
  });
});

describe('plan prices', () => {
  it('reads rand amounts as cents, with a comma or a point', () => {
    expect(parsePriceCents('199')).toBe(19900);
    expect(parsePriceCents('199.99')).toBe(19999);
    expect(parsePriceCents(' 49,5 ')).toBe(4950);
    expect(parsePriceCents('0.1')).toBe(10);
    expect(parsePriceCents('')).toBeNull();
  });

  it('rejects anything that is not a plain amount', () => {
    for (const text of ['-5', '1e3', '12.345', 'R99', '99 rand', '12345678', '.5']) {
      expect(parsePriceCents(text), text).toBeUndefined();
    }
  });
});

describe('reason and confirmation', () => {
  it('requires a reason of 10 to 500 characters, ignoring surrounding spaces', () => {
    expect(REASON_MIN).toBe(10);
    expect(REASON_MAX).toBe(500);
    expect(reasonIssue('')).toBe('tooShort');
    expect(reasonIssue('   too short   ')).toBe('tooShort');
    expect(reasonIssue('Owner asked by email')).toBeNull();
    expect(reasonIssue('x'.repeat(500))).toBeNull();
    expect(reasonIssue('x'.repeat(501))).toBe('tooLong');
  });

  it('matches the typed name loosely on case and spaces only', () => {
    expect(confirmNameMatches('  thandi spaza ', 'Thandi Spaza')).toBe(true);
    expect(confirmNameMatches('Thandi', 'Thandi Spaza')).toBe(false);
    expect(confirmNameMatches('', 'Thandi Spaza')).toBe(false);
  });
});
