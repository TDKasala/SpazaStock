import type { ShopRole } from '../types';
import { getSupabase } from '../lib/supabase';

/** Server-side team management. Every call is authorised again by the database functions. */

export type MemberStatus = 'active' | 'deactivated' | 'invited' | 'expired';

export interface TeamMember {
  memberId: string;
  userId: string | null;
  email: string;
  displayName: string | null;
  role: ShopRole;
  status: MemberStatus;
  isAccountOwner: boolean;
  isYou: boolean;
  joinedAt: string | null;
  invitedAt: string;
  inviteExpiresAt: string | null;
}

export interface IssuedInvite {
  memberId: string;
  email: string;
  role: ShopRole;
  token: string;
  expiresAt: string;
}

export type MembershipAction =
  | 'invited'
  | 'invite_resent'
  | 'invite_revoked'
  | 'joined'
  | 'role_changed'
  | 'deactivated'
  | 'reactivated'
  | 'removed';

export interface MembershipEvent {
  id: string;
  action: MembershipAction;
  targetEmail: string | null;
  oldRole: ShopRole | null;
  newRole: ShopRole | null;
  createdAt: string;
}

export interface InvitePreview {
  shopName: string;
  role: ShopRole;
  email: string;
  invitedBy: string | null;
  expiresAt: string | null;
  expired: boolean;
}

export interface ServiceError {
  code?: string;
  message?: string;
}

export type Result<T> = { data: T; error?: undefined } | { data?: undefined; error: ServiceError };

const NOT_CONFIGURED: ServiceError = { message: 'Supabase is not configured.' };

/** Translation key for a failed team action. */
export function teamErrorKey(error: ServiceError | undefined): string {
  const message = (error?.message ?? '').toLowerCase();
  switch (error?.code) {
    case '42501':
      return 'team.errors.notAllowed';
    case '23505':
      return 'team.errors.alreadyMember';
    case '54000':
      return 'team.errors.tooManyInvites';
    case 'SP001':
      return 'team.errors.shopSuspended';
    case 'SP002':
      return 'team.errors.memberLimit';
    case '22023':
      if (message.includes('owner')) return 'team.errors.ownerProtected';
      if (message.includes('your own')) return 'team.errors.notYourself';
      if (message.includes('email')) return 'team.errors.invalidEmail';
      return 'team.errors.generic';
    default:
      return 'team.errors.generic';
  }
}

/** Translation key for a failed invite acceptance. */
export function inviteErrorKey(error: ServiceError | undefined): string {
  switch (error?.code) {
    case 'SS001':
      return 'invite.errors.invalid';
    case 'SS002':
      return 'invite.errors.expired';
    case 'SS003':
      return 'invite.errors.wrongEmail';
    case 'SS004':
      return 'invite.errors.unconfirmed';
    case 'SS005':
      return 'invite.errors.alreadyMember';
    case 'SP001':
      return 'invite.errors.shopSuspended';
    case 'SP002':
      return 'invite.errors.teamFull';
    default:
      return 'invite.errors.generic';
  }
}

async function call<T>(fn: string, args: Record<string, unknown>, map: (raw: unknown) => T): Promise<Result<T>> {
  const supabase = getSupabase();
  if (!supabase) return { error: NOT_CONFIGURED };
  const { data, error } = await supabase.rpc(fn, args);
  if (error) return { error: { code: error.code, message: error.message } };
  return { data: map(data) };
}

interface TeamMemberRow {
  member_id: string;
  user_id: string | null;
  email: string;
  display_name: string | null;
  role: ShopRole;
  status: MemberStatus;
  is_account_owner: boolean;
  is_you: boolean;
  joined_at: string | null;
  invited_at: string;
  invite_expires_at: string | null;
}

export function listTeam(shopId: string): Promise<Result<TeamMember[]>> {
  return call('list_shop_team', { p_shop_id: shopId }, (raw) =>
    ((raw ?? []) as TeamMemberRow[]).map((r) => ({
      memberId: r.member_id,
      userId: r.user_id,
      email: r.email,
      displayName: r.display_name,
      role: r.role,
      status: r.status,
      isAccountOwner: r.is_account_owner,
      isYou: r.is_you,
      joinedAt: r.joined_at,
      invitedAt: r.invited_at,
      inviteExpiresAt: r.invite_expires_at,
    }))
  );
}

function toIssuedInvite(raw: unknown): IssuedInvite {
  const r = raw as { member_id: string; email: string; role: ShopRole; token: string; expires_at: string };
  return { memberId: r.member_id, email: r.email, role: r.role, token: r.token, expiresAt: r.expires_at };
}

export function inviteMember(shopId: string, email: string, role: 'manager' | 'staff'): Promise<Result<IssuedInvite>> {
  return call('invite_shop_member', { p_shop_id: shopId, p_email: email, p_role: role }, toIssuedInvite);
}

export function resendInvite(memberId: string): Promise<Result<IssuedInvite>> {
  return call('resend_shop_invite', { p_member_id: memberId }, toIssuedInvite);
}

export function updateMemberRole(memberId: string, role: ShopRole): Promise<Result<null>> {
  return call('update_member_role', { p_member_id: memberId, p_role: role }, () => null);
}

export function setMemberStatus(memberId: string, status: 'active' | 'deactivated'): Promise<Result<null>> {
  return call('set_member_status', { p_member_id: memberId, p_status: status }, () => null);
}

/** Removes a member or cancels a pending invite. */
export function removeMember(memberId: string): Promise<Result<null>> {
  return call('remove_shop_member', { p_member_id: memberId }, () => null);
}

export async function listMembershipEvents(shopId: string, limit = 15): Promise<Result<MembershipEvent[]>> {
  const supabase = getSupabase();
  if (!supabase) return { error: NOT_CONFIGURED };
  const { data, error } = await supabase
    .from('membership_events')
    .select('id, action, target_email, old_role, new_role, created_at')
    .eq('shop_id', shopId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return { error: { code: error.code, message: error.message } };
  return {
    data: (data ?? []).map((r) => ({
      id: r.id as string,
      action: r.action as MembershipAction,
      targetEmail: r.target_email as string | null,
      oldRole: r.old_role as ShopRole | null,
      newRole: r.new_role as ShopRole | null,
      createdAt: r.created_at as string,
    })),
  };
}

export function previewInvite(token: string): Promise<Result<InvitePreview | null>> {
  return call('preview_shop_invite', { p_token: token }, (raw) => {
    if (!raw) return null;
    const r = raw as {
      shop_name: string;
      role: ShopRole;
      email: string;
      invited_by: string | null;
      expires_at: string | null;
      expired: boolean;
    };
    return {
      shopName: r.shop_name,
      role: r.role,
      email: r.email,
      invitedBy: r.invited_by,
      expiresAt: r.expires_at,
      expired: r.expired,
    };
  });
}

export function acceptInvite(token: string): Promise<Result<{ shopId: string; role: ShopRole }>> {
  return call('accept_shop_invite', { p_token: token }, (raw) => {
    const r = raw as { shop_id: string; role: ShopRole };
    return { shopId: r.shop_id, role: r.role };
  });
}

export async function getDisplayName(userId: string): Promise<Result<string | null>> {
  const supabase = getSupabase();
  if (!supabase) return { error: NOT_CONFIGURED };
  const { data, error } = await supabase.from('profiles').select('display_name').eq('id', userId).maybeSingle();
  if (error) return { error: { code: error.code, message: error.message } };
  return { data: (data?.display_name as string | null | undefined) ?? null };
}

export async function updateDisplayName(userId: string, name: string): Promise<Result<null>> {
  const supabase = getSupabase();
  if (!supabase) return { error: NOT_CONFIGURED };
  const { error } = await supabase.from('profiles').update({ display_name: name }).eq('id', userId);
  if (error) return { error: { code: error.code, message: error.message } };
  return { data: null };
}
