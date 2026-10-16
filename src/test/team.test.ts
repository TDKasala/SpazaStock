import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AuthApiError, AuthRetryableFetchError } from '@supabase/supabase-js';
import {
  isValidCode,
  isValidDisplayName,
  isValidEmail,
  normalizeDisplayName,
  normalizeEmail,
  passwordProblem,
} from '../lib/authValidation';
import { authErrorKey } from '../lib/authErrors';
import { can, ROLE_PERMISSIONS } from '../lib/permissions';
import { canManageExpiry } from '../lib/shopSettings';
import {
  buildAppLink,
  buildInviteLink,
  captureInviteFromUrl,
  clearPendingInvite,
  isInviteToken,
  parseInviteToken,
  readPendingInvite,
  whatsappShareUrl,
} from '../lib/invite';
import { pickShop, revokedShops, shopFromRow } from '../lib/shopList';
import { inviteErrorKey, teamErrorKey, type MemberStatus, type MembershipAction } from '../services/teamService';
import { clearShopData, db, getMeta, resetLocalDatabase, setMeta } from '../lib/db';
import { en } from '../locales/en';
import type { Shop, ShopRole } from '../types';

const TOKEN = 'ab'.repeat(32);

function lookup(key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], en);
}

describe('auth input rules', () => {
  it('validates and normalises emails', () => {
    expect(isValidEmail(' Thandi@Example.co.za ')).toBe(true);
    expect(isValidEmail('thandi@')).toBe(false);
    expect(isValidEmail('no spaces@example.com')).toBe(false);
    expect(isValidEmail(`${'a'.repeat(250)}@example.com`)).toBe(false);
    expect(normalizeEmail(' Thandi@Example.COM ')).toBe('thandi@example.com');
  });

  it('requires 8 to 72 bytes with letters and digits', () => {
    expect(passwordProblem('abc123')).toBe('auth.errors.passwordTooShort');
    expect(passwordProblem('abcdefgh')).toBe('auth.errors.passwordNeedsMix');
    expect(passwordProblem('12345678')).toBe('auth.errors.passwordNeedsMix');
    expect(passwordProblem('spaza2026')).toBeNull();
    expect(passwordProblem(`a1${'x'.repeat(70)}`)).toBeNull();
    expect(passwordProblem(`a1${'x'.repeat(71)}`)).toBe('auth.errors.passwordTooLong');
    // Multi-byte characters count by bytes, as bcrypt does.
    expect(passwordProblem(`a1${'é'.repeat(36)}`)).toBe('auth.errors.passwordTooLong');
  });

  it('checks codes and display names', () => {
    expect(isValidCode(' 123456 ')).toBe(true);
    expect(isValidCode('12345')).toBe(false);
    expect(isValidCode('12a456')).toBe(false);
    expect(normalizeDisplayName('  Thandi   Nkosi ')).toBe('Thandi Nkosi');
    expect(isValidDisplayName('   ')).toBe(false);
    expect(isValidDisplayName('x'.repeat(80))).toBe(true);
    expect(isValidDisplayName('x'.repeat(81))).toBe(false);
  });
});

describe('auth error messages', () => {
  it('maps Supabase error codes and statuses to translated messages', () => {
    expect(authErrorKey(new AuthApiError('Invalid login credentials', 400, 'invalid_credentials'))).toBe(
      'auth.errors.invalidCredentials'
    );
    expect(authErrorKey(new AuthApiError('Email not confirmed', 400, 'email_not_confirmed'))).toBe(
      'auth.errors.emailNotConfirmed'
    );
    expect(authErrorKey(new AuthApiError('User already registered', 422, 'user_already_exists'))).toBe(
      'auth.errors.emailInUse'
    );
    expect(authErrorKey(new AuthApiError('Token has expired or is invalid', 403, 'otp_expired'))).toBe(
      'auth.errors.codeInvalid'
    );
    expect(authErrorKey(new AuthApiError('Slow down', 429, undefined))).toBe('auth.errors.rateLimited');
    expect(authErrorKey(new AuthRetryableFetchError('Failed to fetch', 0))).toBe('auth.errors.network');
    expect(authErrorKey({ message: 'Invalid login credentials' })).toBe('auth.errors.invalidCredentials');
    expect(authErrorKey(new Error('???'))).toBe('auth.errors.generic');
  });

  it('maps team and invite errors from the database functions', () => {
    expect(teamErrorKey({ code: '42501' })).toBe('team.errors.notAllowed');
    expect(teamErrorKey({ code: '23505' })).toBe('team.errors.alreadyMember');
    expect(teamErrorKey({ code: '54000' })).toBe('team.errors.tooManyInvites');
    expect(teamErrorKey({ code: '22023', message: 'The account owner cannot be removed, demoted or deactivated.' })).toBe(
      'team.errors.ownerProtected'
    );
    expect(teamErrorKey({ code: '22023', message: 'You cannot change your own role.' })).toBe('team.errors.notYourself');
    expect(teamErrorKey({ code: '22023', message: 'A valid email address is required.' })).toBe('team.errors.invalidEmail');
    expect(teamErrorKey(undefined)).toBe('team.errors.generic');

    expect(inviteErrorKey({ code: 'SS001' })).toBe('invite.errors.invalid');
    expect(inviteErrorKey({ code: 'SS002' })).toBe('invite.errors.expired');
    expect(inviteErrorKey({ code: 'SS003' })).toBe('invite.errors.wrongEmail');
    expect(inviteErrorKey({ code: 'SS004' })).toBe('invite.errors.unconfirmed');
    expect(inviteErrorKey({ code: 'SS005' })).toBe('invite.errors.alreadyMember');
    expect(inviteErrorKey({ code: 'XX000' })).toBe('invite.errors.generic');
  });

  it('only returns message keys that exist', () => {
    const files = ['lib/authErrors.ts', 'lib/authValidation.ts', 'services/teamService.ts', 'context/AuthContext.tsx'];
    const keys = new Set<string>();
    for (const file of files) {
      const source = readFileSync(join(__dirname, '..', file), 'utf8');
      for (const match of source.matchAll(/'((?:auth|team|invite)\.[\w.]+)'/g)) keys.add(match[1]);
    }
    expect(keys.size).toBeGreaterThan(20);
    expect([...keys].filter((key) => typeof lookup(key) !== 'string')).toEqual([]);
  });

  it('has labels for every role, status and audit action shown on the team screen', () => {
    const roles: ShopRole[] = ['owner', 'manager', 'staff'];
    const statuses: MemberStatus[] = ['active', 'invited', 'expired', 'deactivated'];
    const actions: MembershipAction[] = [
      'invited',
      'invite_resent',
      'invite_revoked',
      'joined',
      'role_changed',
      'deactivated',
      'reactivated',
      'removed',
    ];
    const keys = [
      ...roles.map((r) => `roles.${r}`),
      ...roles.map((r) => `team.roleHelp.${r}`),
      ...statuses.map((s) => `team.status.${s}`),
      ...actions.map((a) => `team.events.${a}`),
    ];
    expect(keys.filter((key) => typeof lookup(key) !== 'string')).toEqual([]);
    expect(en.roles.staff).toBe('Worker');
  });
});

describe('permissions', () => {
  it('gives workers only day-to-day work and owners everything', () => {
    expect(can('staff', 'sales.record')).toBe(true);
    expect(can('staff', 'stock.receive')).toBe(true);
    expect(can('staff', 'inventory.view')).toBe(true);
    expect(can('staff', 'team.manage')).toBe(false);
    expect(can('staff', 'billing.view')).toBe(false);
    expect(can('staff', 'products.edit')).toBe(false);
    expect(can('manager', 'expiry.manage')).toBe(true);
    expect(can('manager', 'team.manage')).toBe(false);
    expect(can('manager', 'shop.settings')).toBe(false);
    for (const permission of ROLE_PERMISSIONS.manager) expect(can('owner', permission)).toBe(true);
    expect(can(undefined, 'inventory.view')).toBe(false);
    expect(canManageExpiry('staff')).toBe(false);
    expect(canManageExpiry('manager')).toBe(true);
  });
});

describe('invite links', () => {
  beforeEach(() => {
    clearPendingInvite();
    window.history.replaceState(null, '', '/');
  });

  it('builds and parses links with a 64-character hex token', () => {
    const link = buildInviteLink('https://spazastock.example', TOKEN);
    expect(link).toBe(`https://spazastock.example/?invite=${TOKEN}`);
    expect(parseInviteToken(new URL(link).search)).toBe(TOKEN);
    expect(parseInviteToken(`?invite=${TOKEN.toUpperCase()}`)).toBe(TOKEN);
    expect(parseInviteToken('?invite=short')).toBeNull();
    expect(parseInviteToken('?invite=<script>')).toBeNull();
    expect(parseInviteToken('')).toBeNull();
    expect(isInviteToken(TOKEN)).toBe(true);
    expect(isInviteToken(`${TOKEN}0`)).toBe(false);
    expect(whatsappShareUrl('Join & sell')).toBe('https://wa.me/?text=Join%20%26%20sell');
    expect(buildAppLink('https://spazastock.example')).toBe('https://spazastock.example/');
  });

  it('moves the token from the address bar into session storage', () => {
    window.history.replaceState(null, '', `/?invite=${TOKEN}&tab=alerts#top`);
    expect(captureInviteFromUrl()).toBe(TOKEN);
    expect(window.location.search).toBe('?tab=alerts');
    expect(window.location.hash).toBe('#top');
    // Still pending after a reload (no token in the URL any more).
    expect(captureInviteFromUrl()).toBe(TOKEN);
    expect(readPendingInvite()).toBe(TOKEN);
    clearPendingInvite();
    expect(captureInviteFromUrl()).toBeNull();
  });

  it('drops a malformed token from the address bar without storing it', () => {
    window.history.replaceState(null, '', '/?invite=nope');
    expect(captureInviteFromUrl()).toBeNull();
    expect(window.location.search).toBe('');
  });
});

describe('shop list', () => {
  const a: Shop = { id: 'a', name: 'A', role: 'owner' };
  const b: Shop = { id: 'b', name: 'B', role: 'staff' };

  it('maps database rows', () => {
    expect(
      shopFromRow({ id: 'a', name: 'A', timezone: 'Africa/Johannesburg', expiry_reminder_days: [7], role: 'manager', is_account_owner: false })
    ).toEqual({ id: 'a', name: 'A', timezone: 'Africa/Johannesburg', reminderDays: [7], role: 'manager', isAccountOwner: false });
    expect(
      shopFromRow({ id: 'a', name: 'A', phone: '+27821234567', address: '12 Main Road', city: 'Soweto', province: 'GP' })
    ).toMatchObject({ phone: '+27821234567', address: '12 Main Road', city: 'Soweto', province: 'GP' });
  });

  it('finds shops whose access has ended', () => {
    expect(revokedShops([a, b], [a])).toEqual([b]);
    expect(revokedShops([a], [a, b])).toEqual([]);
    expect(revokedShops([], [])).toEqual([]);
  });

  it('keeps the chosen shop while the user still belongs to it', () => {
    expect(pickShop([a, b], 'b')).toBe(b);
    expect(pickShop([a, b], 'gone')).toBe(a);
    expect(pickShop([a, b], null)).toBe(a);
    expect(pickShop([], 'b')).toBeNull();
  });
});

describe('clearing a shop from the phone', () => {
  beforeEach(async () => {
    await resetLocalDatabase();
  });

  it('removes only that shop, including queued changes and sync cursors', async () => {
    const now = new Date().toISOString();
    const product = (shopId: string, id: string) => ({
      id,
      shopId,
      barcode: id,
      name: id,
      category: 'other' as const,
      createdAt: now,
      updatedAt: now,
    });
    await db.products.bulkAdd([product('gone', 'p1'), product('kept', 'p2')]);
    await db.outbox.bulkAdd([
      { id: 'o1', shopId: 'gone', type: 'product_upsert', payload: { product: product('gone', 'p1') }, status: 'pending', attempts: 0, nextAttemptAt: 0, createdAt: now },
      { id: 'o2', shopId: 'kept', type: 'product_upsert', payload: { product: product('kept', 'p2') }, status: 'pending', attempts: 0, nextAttemptAt: 0, createdAt: now },
    ]);
    await setMeta('pull:gone:products', now);
    await setMeta('lastSync:gone', now);
    await setMeta('pull:kept:products', now);

    await clearShopData('gone');

    expect((await db.products.toArray()).map((p) => p.id)).toEqual(['p2']);
    expect((await db.outbox.toArray()).map((o) => o.id)).toEqual(['o2']);
    expect(await getMeta('pull:gone:products')).toBeUndefined();
    expect(await getMeta('lastSync:gone')).toBeUndefined();
    expect(await getMeta('pull:kept:products')).toBe(now);
  });
});
