import React, { useEffect, useState } from 'react';
import { UserPlus } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { ErrorMessage } from '../../components/ui/ErrorMessage';
import { adminApi, adminErrorMessage } from '../api';
import { useAdminI18n } from '../i18n';
import { formatDateTime } from '../format';
import { PLATFORM_ROLES, type PlatformRole } from '../permissions';
import type { AdminListRow } from '../types';
import { useAdminQuery } from '../useAdminQuery';
import { DataTable, type Column } from '../components/DataTable';
import { StatusBadge } from '../components/StatusBadge';
import { ReasonConfirmDialog } from '../components/ReasonConfirmDialog';
import { selectClass } from '../components/DateRangeFilter';
import { Field, fieldClass, PageHeader, Section } from '../components/PageParts';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const AdminsPage: React.FC = () => {
  const { at, locale } = useAdminI18n();
  const admins = useAdminQuery('admins', () => adminApi.listAdmins().then((r) => r.rows));
  const [granting, setGranting] = useState(false);
  const [changing, setChanging] = useState<AdminListRow | null>(null);
  const [revoking, setRevoking] = useState<AdminListRow | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const done = (message: string) => {
    setNotice(message);
    admins.reload();
  };

  const columns: Column<AdminListRow>[] = [
    {
      key: 'email',
      header: at('admins.email'),
      render: (a) => (
        <span>
          {a.email}
          {a.is_you && <span className="ml-2 text-xs text-emerald-400">({at('admins.you')})</span>}
          {a.display_name && <span className="block text-xs text-zinc-500 font-normal">{a.display_name}</span>}
        </span>
      ),
    },
    { key: 'role', header: at('admins.role'), render: (a) => at(`roles.${a.role}`) },
    { key: 'status', header: at('common.status'), render: (a) => <StatusBadge value={a.status} /> },
    {
      key: 'granted',
      header: at('admins.granted'),
      render: (a) => (
        <span className="text-xs">
          {formatDateTime(a.granted_at, locale)}
          <span className="block text-zinc-500">{a.granted_by_email ?? at('admins.bootstrap')}</span>
        </span>
      ),
    },
    {
      key: 'revoked',
      header: at('admins.revoked'),
      render: (a) =>
        a.revoked_at ? (
          <span className="text-xs">
            {formatDateTime(a.revoked_at, locale)}
            <span className="block text-zinc-500">{a.revoked_by_email ?? at('common.none')}</span>
          </span>
        ) : (
          at('common.none')
        ),
    },
    { key: 'signin', header: at('admins.lastSignIn'), render: (a) => formatDateTime(a.last_sign_in_at, locale) },
    {
      key: 'actions',
      header: at('common.actions'),
      render: (a) =>
        a.is_you || a.status !== 'active' ? (
          <span className="text-xs text-zinc-500">{a.is_you ? at('admins.cannotChangeSelf') : at('common.none')}</span>
        ) : (
          <span className="flex gap-1">
            <Button variant="ghost" size="sm" onClick={() => setChanging(a)}>
              {at('admins.changeRole')}
            </Button>
            <Button variant="ghost" size="sm" className="text-rose-300" onClick={() => setRevoking(a)}>
              {at('admins.revoke')}
            </Button>
          </span>
        ),
    },
  ];

  return (
    <>
      <PageHeader
        title={at('admins.title')}
        description={at('admins.description')}
        actions={
          <Button size="sm" leftIcon={<UserPlus className="w-4 h-4" />} onClick={() => setGranting(true)}>
            {at('admins.grant')}
          </Button>
        }
      />
      {notice && <ErrorMessage variant="success" message={notice} onDismiss={() => setNotice(null)} />}

      <DataTable
        caption={at('admins.title')}
        hideCaption
        columns={columns}
        rows={admins.data}
        rowKey={(a) => a.user_id}
        isLoading={admins.isLoading}
        error={admins.error ? adminErrorMessage(admins.error, at) : null}
        onRetry={admins.reload}
      />

      <Section title={at('admins.rolesTitle')}>
        <dl className="grid gap-3 sm:grid-cols-2 text-sm">
          {PLATFORM_ROLES.map((role) => (
            <div key={role}>
              <dt className="font-medium text-zinc-200">{at(`roles.${role}`)}</dt>
              <dd className="text-zinc-400">{at(`roleDescriptions.${role}`)}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <GrantDialog
        isOpen={granting}
        onClose={() => setGranting(false)}
        onDone={() => {
          setGranting(false);
          done(at('admins.grantedNotice'));
        }}
      />
      <ChangeRoleDialog
        target={changing}
        onClose={() => setChanging(null)}
        onDone={() => {
          setChanging(null);
          done(at('admins.roleChangedNotice'));
        }}
      />
      <ReasonConfirmDialog
        isOpen={revoking !== null}
        title={at('admins.revokeTitle', { email: revoking?.email ?? '' })}
        description={at('admins.revokeDescription')}
        confirmLabel={at('admins.revoke')}
        danger
        confirmName={revoking?.email}
        onConfirm={async (reason) => {
          if (!revoking) return;
          await adminApi.revokeAdmin(revoking.user_id, reason);
          setRevoking(null);
          done(at('admins.revokedNotice'));
        }}
        onClose={() => setRevoking(null)}
      />
    </>
  );
};

const RoleSelect: React.FC<{ id: string; value: PlatformRole; onChange: (role: PlatformRole) => void }> = ({ id, value, onChange }) => {
  const { at } = useAdminI18n();
  return (
    <Field id={id} label={at('admins.role')} hint={at(`roleDescriptions.${value}`)}>
      <select id={id} className={selectClass} value={value} onChange={(e) => onChange(e.target.value as PlatformRole)}>
        {PLATFORM_ROLES.map((role) => (
          <option key={role} value={role}>
            {at(`roles.${role}`)}
          </option>
        ))}
      </select>
    </Field>
  );
};

const GrantDialog: React.FC<{ isOpen: boolean; onClose: () => void; onDone: () => void }> = ({ isOpen, onClose, onDone }) => {
  const { at } = useAdminI18n();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<PlatformRole>('support');

  useEffect(() => {
    if (!isOpen) return;
    setEmail('');
    setRole('support');
  }, [isOpen]);

  return (
    <ReasonConfirmDialog
      isOpen={isOpen}
      title={at('admins.grantTitle')}
      description={at('admins.grantDescription')}
      confirmLabel={at('admins.grant')}
      canSubmit={EMAIL.test(email.trim())}
      onConfirm={async (reason) => {
        await adminApi.grantAdmin(email.trim(), role, reason);
        onDone();
      }}
      onClose={onClose}
    >
      <Field id="grant-email" label={at('admins.email')}>
        <input
          id="grant-email"
          type="email"
          autoComplete="off"
          className={fieldClass}
          value={email}
          maxLength={320}
          onChange={(e) => setEmail(e.target.value)}
        />
      </Field>
      <RoleSelect id="grant-role" value={role} onChange={setRole} />
    </ReasonConfirmDialog>
  );
};

const ChangeRoleDialog: React.FC<{ target: AdminListRow | null; onClose: () => void; onDone: () => void }> = ({
  target,
  onClose,
  onDone,
}) => {
  const { at } = useAdminI18n();
  const [role, setRole] = useState<PlatformRole>('support');

  useEffect(() => {
    if (target) setRole(target.role);
  }, [target]);

  return (
    <ReasonConfirmDialog
      isOpen={target !== null}
      title={at('admins.changeRoleTitle', { email: target?.email ?? '' })}
      description={at('admins.changeRoleDescription')}
      confirmLabel={at('common.save')}
      canSubmit={target !== null && role !== target.role}
      onConfirm={async (reason) => {
        if (!target) return;
        await adminApi.setAdminRole(target.user_id, role, reason);
        onDone();
      }}
      onClose={onClose}
    >
      <RoleSelect id="change-role" value={role} onChange={setRole} />
    </ReasonConfirmDialog>
  );
};
