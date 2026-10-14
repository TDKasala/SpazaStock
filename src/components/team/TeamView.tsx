import React, { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, RefreshCw, UserPlus, Users } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { useShop } from '../../context/ShopContext';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Dialog } from '../ui/Dialog';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { ErrorMessage } from '../ui/ErrorMessage';
import { LoadingState } from '../ui/LoadingState';
import { formatShortDate } from '../../lib/dates';
import {
  listMembershipEvents,
  listTeam,
  removeMember,
  resendInvite,
  setMemberStatus,
  teamErrorKey,
  updateMemberRole,
  type IssuedInvite,
  type MembershipEvent,
  type Result,
  type TeamMember,
} from '../../services/teamService';
import type { ShopRole } from '../../types';
import { InviteDialog, RoleOption } from './InviteDialog';

type PendingAction =
  | { kind: 'deactivate'; member: TeamMember }
  | { kind: 'remove'; member: TeamMember }
  | { kind: 'revoke'; member: TeamMember }
  | { kind: 'role'; member: TeamMember };

const STATUS_STYLES: Record<TeamMember['status'], string> = {
  active: 'bg-emerald-950/40 text-emerald-300 border-emerald-800/60',
  invited: 'bg-sky-950/40 text-sky-300 border-sky-800/60',
  expired: 'bg-amber-950/40 text-amber-300 border-amber-800/60',
  deactivated: 'bg-zinc-800 text-zinc-400 border-zinc-700',
};

function nameOf(member: TeamMember): string {
  return member.displayName ?? member.email;
}

export const TeamView: React.FC<{ onBack: () => void }> = ({ onBack }) => {
  const { t, locale } = useLanguage();
  const { shop } = useShop();
  const shopId = shop?.id ?? '';
  const shopName = shop?.name ?? '';
  const [members, setMembers] = useState<TeamMember[] | null>(null);
  const [events, setEvents] = useState<MembershipEvent[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isInviteOpen, setIsInviteOpen] = useState(false);
  const [issued, setIssued] = useState<IssuedInvite | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [newRole, setNewRole] = useState<ShopRole>('staff');
  const [busyMemberId, setBusyMemberId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!shopId) return;
    setLoadError(false);
    const [team, history] = await Promise.all([listTeam(shopId), listMembershipEvents(shopId)]);
    if (team.error) {
      setLoadError(true);
      return;
    }
    setMembers(team.data);
    setEvents(history.data ?? []);
  }, [shopId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Runs a team change, then reloads; returns true on success. */
  const run = async (action: () => Promise<Result<unknown>>, successMessage: string): Promise<boolean> => {
    if (!navigator.onLine) {
      setError(t('team.needsOnline'));
      return false;
    }
    setError(null);
    setNotice(null);
    const res = await action();
    if (res.error) {
      setError(t(teamErrorKey(res.error)));
      return false;
    }
    setNotice(successMessage);
    await load();
    return true;
  };

  const handleResend = async (member: TeamMember) => {
    if (!navigator.onLine) return setError(t('team.needsOnline'));
    setBusyMemberId(member.memberId);
    setError(null);
    const res = await resendInvite(member.memberId);
    setBusyMemberId(null);
    if (res.error) return setError(t(teamErrorKey(res.error)));
    setIssued(res.data);
    setIsInviteOpen(true);
    await load();
  };

  const handleReactivate = async (member: TeamMember) => {
    setBusyMemberId(member.memberId);
    await run(() => setMemberStatus(member.memberId, 'active'), t('team.done.reactivated', { name: nameOf(member) }));
    setBusyMemberId(null);
  };

  const confirmPending = async () => {
    if (!pending) return;
    const { member } = pending;
    const name = nameOf(member);
    let ok = false;
    if (pending.kind === 'deactivate') {
      ok = await run(() => setMemberStatus(member.memberId, 'deactivated'), t('team.done.deactivated', { name }));
    } else if (pending.kind === 'remove') {
      ok = await run(() => removeMember(member.memberId), t('team.done.removed', { name }));
    } else if (pending.kind === 'revoke') {
      ok = await run(() => removeMember(member.memberId), t('team.done.revoked'));
    } else {
      ok = await run(
        () => updateMemberRole(member.memberId, newRole),
        t('team.done.roleChanged', { name, role: t(`roles.${newRole}`) })
      );
    }
    if (ok) setPending(null);
  };

  const describeEvent = (event: MembershipEvent): string => {
    const role = (r: ShopRole | null) => (r ? t(`roles.${r}`) : '');
    return t(`team.events.${event.action}`, {
      email: event.targetEmail ?? '?',
      role: role(event.newRole ?? event.oldRole),
      from: role(event.oldRole),
      to: role(event.newRole),
    });
  };

  return (
    <div className="space-y-5 pb-24">
      <div className="flex items-center gap-3">
        <button
          onClick={onBack}
          className="p-2 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-300 hover:text-white"
          aria-label={t('team.back')}
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div className="min-w-0">
          <h2 className="text-lg font-bold text-zinc-100">{t('team.title')}</h2>
          <p className="text-xs text-zinc-400 truncate">{t('team.subtitle', { shop: shopName })}</p>
        </div>
      </div>

      {error && <ErrorMessage variant="error" message={error} onDismiss={() => setError(null)} />}
      {notice && <ErrorMessage variant="success" message={notice} onDismiss={() => setNotice(null)} />}

      <Button fullWidth leftIcon={<UserPlus className="w-4 h-4" />} onClick={() => {
        setIssued(null);
        setIsInviteOpen(true);
      }}>
        {t('team.invite')}
      </Button>

      {loadError ? (
        <ErrorMessage
          variant="warning"
          message={t('team.loadError')}
          action={{ label: t('common.retry'), onClick: () => void load() }}
        />
      ) : members === null ? (
        <LoadingState message={t('common.loading')} />
      ) : (
        <div className="space-y-3">
          {members.length <= 1 && (
            <Card className="flex items-center gap-3 text-sm text-zinc-400">
              <Users className="w-5 h-5 text-zinc-500 shrink-0" />
              {t('team.empty')}
            </Card>
          )}
          {members.map((member) => {
            const locked = member.isYou || member.isAccountOwner;
            const isPendingInvite = member.status === 'invited' || member.status === 'expired';
            return (
              <Card key={member.memberId} className="space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-zinc-100 truncate">
                      {isPendingInvite ? member.email : nameOf(member)}
                      {member.isYou && <span className="ml-2 text-xs font-normal text-zinc-500">({t('team.you')})</span>}
                    </p>
                    {!isPendingInvite && <p className="text-xs text-zinc-400 truncate">{member.email}</p>}
                    {isPendingInvite && member.inviteExpiresAt && member.status === 'invited' && (
                      <p className="text-xs text-zinc-500">
                        {t('team.expiresOn', { date: formatShortDate(member.inviteExpiresAt, locale) })}
                      </p>
                    )}
                    {member.status === 'expired' && (
                      <p className="text-xs text-zinc-500">
                        {t('team.invitedOn', { date: formatShortDate(member.invitedAt, locale) })}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <span className="px-2 py-0.5 rounded-md text-[11px] font-semibold bg-zinc-800 text-zinc-200 border border-zinc-700">
                      {t(`roles.${member.role}`)}
                    </span>
                    <span className={`px-2 py-0.5 rounded-md text-[11px] font-medium border ${STATUS_STYLES[member.status]}`}>
                      {t(`team.status.${member.status}`)}
                    </span>
                    {member.isAccountOwner && <span className="text-[11px] text-zinc-500">{t('team.accountOwner')}</span>}
                  </div>
                </div>

                {!locked && (
                  <div className="flex flex-wrap gap-2">
                    {isPendingInvite ? (
                      <>
                        <Button
                          size="sm"
                          variant="secondary"
                          leftIcon={<RefreshCw className="w-3.5 h-3.5" />}
                          isLoading={busyMemberId === member.memberId}
                          onClick={() => void handleResend(member)}
                        >
                          {t('team.actions.resend')}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setPending({ kind: 'revoke', member })}>
                          {t('team.actions.revoke')}
                        </Button>
                      </>
                    ) : member.status === 'deactivated' ? (
                      <>
                        <Button
                          size="sm"
                          variant="secondary"
                          isLoading={busyMemberId === member.memberId}
                          onClick={() => void handleReactivate(member)}
                        >
                          {t('team.actions.reactivate')}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setPending({ kind: 'remove', member })}>
                          {t('team.actions.remove')}
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => {
                            setNewRole(member.role);
                            setPending({ kind: 'role', member });
                          }}
                        >
                          {t('team.actions.changeRole')}
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setPending({ kind: 'deactivate', member })}>
                          {t('team.actions.deactivate')}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setPending({ kind: 'remove', member })}>
                          {t('team.actions.remove')}
                        </Button>
                      </>
                    )}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {members !== null && (
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{t('team.activity')}</h3>
          {events.length === 0 ? (
            <p className="text-xs text-zinc-500">{t('team.noActivity')}</p>
          ) : (
            <ul className="space-y-1.5">
              {events.map((event) => (
                <li key={event.id} className="flex items-start justify-between gap-3 text-xs">
                  <span className="text-zinc-300">{describeEvent(event)}</span>
                  <span className="text-zinc-500 shrink-0">{formatShortDate(event.createdAt, locale)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <InviteDialog
        isOpen={isInviteOpen}
        shopId={shopId}
        shopName={shopName}
        issued={issued}
        onClose={() => {
          setIsInviteOpen(false);
          setIssued(null);
        }}
        onInvited={() => void load()}
      />

      {pending && pending.kind !== 'role' && (
        <ConfirmDialog
          isOpen
          danger
          title={
            pending.kind === 'deactivate'
              ? t('team.confirm.deactivateTitle', { name: nameOf(pending.member) })
              : pending.kind === 'remove'
                ? t('team.confirm.removeTitle', { name: nameOf(pending.member) })
                : t('team.confirm.revokeTitle', { email: pending.member.email })
          }
          body={
            pending.kind === 'deactivate'
              ? t('team.confirm.deactivateBody', { shop: shopName })
              : pending.kind === 'remove'
                ? t('team.confirm.removeBody', { shop: shopName })
                : t('team.confirm.revokeBody')
          }
          confirmLabel={
            pending.kind === 'deactivate'
              ? t('team.actions.deactivate')
              : pending.kind === 'remove'
                ? t('team.actions.remove')
                : t('team.actions.revoke')
          }
          onConfirm={confirmPending}
          onClose={() => setPending(null)}
        />
      )}

      {pending?.kind === 'role' && (
        <RoleDialog
          name={nameOf(pending.member)}
          role={newRole}
          onChange={setNewRole}
          onSave={confirmPending}
          onClose={() => setPending(null)}
          unchanged={newRole === pending.member.role}
        />
      )}
    </div>
  );
};

const RoleDialog: React.FC<{
  name: string;
  role: ShopRole;
  unchanged: boolean;
  onChange: (role: ShopRole) => void;
  onSave: () => Promise<void>;
  onClose: () => void;
}> = ({ name, role, unchanged, onChange, onSave, onClose }) => {
  const { t } = useLanguage();
  const [isBusy, setIsBusy] = useState(false);
  const save = async () => {
    setIsBusy(true);
    try {
      await onSave();
    } finally {
      setIsBusy(false);
    }
  };
  return (
    <Dialog
      isOpen
      onClose={onClose}
      title={t('team.confirm.roleTitle', { name })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={isBusy}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void save()} isLoading={isBusy} disabled={unchanged}>
            {t('team.confirm.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        {(['staff', 'manager', 'owner'] as const).map((option) => (
          <RoleOption key={option} role={option} checked={role === option} onSelect={() => onChange(option)} />
        ))}
      </div>
    </Dialog>
  );
};
