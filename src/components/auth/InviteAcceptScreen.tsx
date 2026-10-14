import React, { useEffect, useState } from 'react';
import { MailCheck, Users } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { rememberSelectedShop } from '../../context/ShopContext';
import { Button } from '../ui/Button';
import { ErrorMessage } from '../ui/ErrorMessage';
import { LoadingState } from '../ui/LoadingState';
import { clearPendingInvite } from '../../lib/invite';
import { normalizeEmail } from '../../lib/authValidation';
import { acceptInvite, inviteErrorKey, previewInvite, type InvitePreview } from '../../services/teamService';
import { AuthLayout, LinkButton } from './AuthLayout';
import { SignInScreen } from './SignInScreen';

type PreviewState = { status: 'loading' } | { status: 'ready'; invite: InvitePreview } | { status: 'error'; key: string };

interface InviteAcceptScreenProps {
  token: string;
  /** Called once the invite is accepted or set aside; the normal app takes over. */
  onDone: () => void;
}

export const InviteAcceptScreen: React.FC<InviteAcceptScreenProps> = ({ token, onDone }) => {
  const { user, signOut } = useAuth();
  const { t } = useLanguage();
  const [preview, setPreview] = useState<PreviewState>({ status: 'loading' });
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  useEffect(() => {
    if (!navigator.onLine) {
      setPreview({ status: 'error', key: 'invite.errors.offline' });
      return;
    }
    let active = true;
    void previewInvite(token).then((res) => {
      if (!active) return;
      if (res.error || !res.data) setPreview({ status: 'error', key: res.error ? 'invite.errors.generic' : 'invite.errors.invalid' });
      else if (res.data.expired) setPreview({ status: 'error', key: 'invite.errors.expired' });
      else setPreview({ status: 'ready', invite: res.data });
    });
    return () => {
      active = false;
    };
  }, [token]);

  const dismiss = () => {
    clearPendingInvite();
    onDone();
  };

  if (preview.status === 'loading') {
    return (
      <AuthLayout title={t('invite.title')}>
        <LoadingState message={t('invite.checking')} />
      </AuthLayout>
    );
  }

  if (preview.status === 'error') {
    return (
      <AuthLayout title={t('invite.title')}>
        <ErrorMessage variant="warning" message={t(preview.key)} />
        <Button fullWidth variant="secondary" onClick={dismiss}>
          {t('common.close')}
        </Button>
      </AuthLayout>
    );
  }

  const { invite } = preview;
  const role = t(`roles.${invite.role}`);
  const banner = (
    <div className="p-4 rounded-2xl border border-emerald-800/60 bg-emerald-950/30 flex items-start gap-3">
      <Users className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
      <div className="space-y-1">
        <p className="text-sm font-semibold text-emerald-100">
          {invite.invitedBy
            ? t('invite.body', { inviter: invite.invitedBy, shop: invite.shopName, role })
            : t('invite.bodyNoInviter', { shop: invite.shopName, role })}
        </p>
        <p className="text-xs text-emerald-200/80 leading-relaxed">{t('invite.forEmail', { email: invite.email })}</p>
      </div>
    </div>
  );

  if (!user) {
    return <SignInScreen lockedEmail={invite.email} banner={banner} initialView="register" />;
  }

  const accept = async () => {
    if (!navigator.onLine) return setError(t('invite.errors.offline'));
    setIsBusy(true);
    setError(null);
    const res = await acceptInvite(token);
    setIsBusy(false);
    if (res.error) {
      if (res.error.code === 'SS005') return dismiss();
      return setError(t(inviteErrorKey(res.error)));
    }
    rememberSelectedShop(user.id, res.data.shopId);
    dismiss();
  };

  const emailMatches = user.email !== null && normalizeEmail(user.email) === invite.email;

  return (
    <AuthLayout title={t('invite.title')} banner={banner}>
      {error && <ErrorMessage variant="error" message={error} onDismiss={() => setError(null)} />}
      {emailMatches ? (
        <Button fullWidth isLoading={isBusy} onClick={() => void accept()} leftIcon={<MailCheck className="w-4 h-4" />}>
          {t('invite.join', { shop: invite.shopName })}
        </Button>
      ) : (
        <>
          <ErrorMessage
            variant="warning"
            message={t('invite.wrongEmail', { current: user.email ?? '', email: invite.email })}
          />
          <Button fullWidth variant="secondary" onClick={() => void signOut()}>
            {t('invite.switchAccount', { email: invite.email })}
          </Button>
        </>
      )}
      <LinkButton onClick={dismiss}>{t('invite.decline')}</LinkButton>
    </AuthLayout>
  );
};
