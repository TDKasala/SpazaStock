import React, { useEffect, useState } from 'react';
import { Check, Copy, Mail, MessageCircle, Share2 } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { ErrorMessage } from '../ui/ErrorMessage';
import { isValidEmail } from '../../lib/authValidation';
import { buildInviteLink, whatsappShareUrl } from '../../lib/invite';
import { formatShortDate } from '../../lib/dates';
import { inviteMember, teamErrorKey, type IssuedInvite } from '../../services/teamService';

type InviteRole = 'manager' | 'staff';

interface InviteDialogProps {
  isOpen: boolean;
  shopId: string;
  shopName: string;
  /** Show this invite's link straight away (after "New invite link"). */
  issued?: IssuedInvite | null;
  onClose: () => void;
  onInvited: () => void;
}

export const InviteDialog: React.FC<InviteDialogProps> = ({ isOpen, shopId, shopName, issued, onClose, onInvited }) => {
  const { t } = useLanguage();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<InviteRole>('staff');
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [invite, setInvite] = useState<IssuedInvite | null>(issued ?? null);

  useEffect(() => {
    if (!isOpen) return;
    setInvite(issued ?? null);
    setEmail('');
    setRole('staff');
    setError(null);
  }, [isOpen, issued]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValidEmail(email)) return setError(t('team.errors.invalidEmail'));
    if (!navigator.onLine) return setError(t('team.needsOnline'));
    setIsBusy(true);
    setError(null);
    const res = await inviteMember(shopId, email, role);
    setIsBusy(false);
    if (res.error) return setError(t(teamErrorKey(res.error)));
    setInvite(res.data);
    onInvited();
  };

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={invite ? t('team.linkReady') : t('team.inviteTitle', { shop: shopName })}
    >
      {invite ? (
        <InviteLinkPanel invite={invite} shopName={shopName} onDone={onClose} />
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && <ErrorMessage variant="error" message={error} onDismiss={() => setError(null)} />}
          <Input
            label={t('team.inviteEmail')}
            type="email"
            inputMode="email"
            autoComplete="off"
            placeholder="worker@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            leftIcon={<Mail className="w-4 h-4" />}
            autoFocus
          />
          <fieldset className="space-y-2">
            <legend className="text-xs font-medium text-zinc-300 mb-1.5">{t('team.inviteRole')}</legend>
            {(['staff', 'manager'] as const).map((option) => (
              <RoleOption key={option} role={option} checked={role === option} onSelect={() => setRole(option)} />
            ))}
          </fieldset>
          <Button type="submit" fullWidth isLoading={isBusy}>
            {t('team.createInvite')}
          </Button>
        </form>
      )}
    </Dialog>
  );
};

export const RoleOption: React.FC<{ role: 'owner' | 'manager' | 'staff'; checked: boolean; onSelect: () => void }> = ({
  role,
  checked,
  onSelect,
}) => {
  const { t } = useLanguage();
  return (
    <label
      className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-colors ${
        checked ? 'border-emerald-600 bg-emerald-950/30' : 'border-zinc-800 hover:border-zinc-700'
      }`}
    >
      <input type="radio" name="role" checked={checked} onChange={onSelect} className="mt-1 accent-emerald-500" />
      <span>
        <span className="block text-sm font-semibold text-zinc-100">{t(`roles.${role}`)}</span>
        <span className="block text-xs text-zinc-400 mt-0.5 leading-relaxed">{t(`team.roleHelp.${role}`)}</span>
      </span>
    </label>
  );
};

const InviteLinkPanel: React.FC<{ invite: IssuedInvite; shopName: string; onDone: () => void }> = ({
  invite,
  shopName,
  onDone,
}) => {
  const { t, locale } = useLanguage();
  const [copied, setCopied] = useState(false);
  const link = buildInviteLink(window.location.origin, invite.token);
  const shareText = t('team.shareText', { shop: shopName, link });
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked: the link is selectable in the field below.
    }
  };

  const share = async () => {
    try {
      await navigator.share({ title: 'SpazaStock', text: shareText });
    } catch {
      // Cancelled by the user.
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-zinc-400 leading-relaxed">
        {t('team.linkHelp', { email: invite.email, date: formatShortDate(invite.expiresAt, locale) })}
      </p>
      <input
        readOnly
        value={link}
        onFocus={(e) => e.currentTarget.select()}
        className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2.5 text-xs text-zinc-300 font-mono"
        aria-label={t('team.copyLink')}
      />
      <div className="grid grid-cols-2 gap-2">
        <Button
          variant="secondary"
          onClick={() => void copy()}
          leftIcon={copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
        >
          {copied ? t('team.copied') : t('team.copyLink')}
        </Button>
        {canShare ? (
          <Button variant="secondary" onClick={() => void share()} leftIcon={<Share2 className="w-4 h-4" />}>
            {t('team.share')}
          </Button>
        ) : (
          <a
            href={whatsappShareUrl(shareText)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center gap-2 rounded-xl text-sm font-medium min-h-[46px] bg-zinc-800 hover:bg-zinc-700 text-zinc-100 border border-zinc-700/60"
          >
            <MessageCircle className="w-4 h-4" />
            {t('team.shareWhatsApp')}
          </a>
        )}
      </div>
      {canShare && (
        <a
          href={whatsappShareUrl(shareText)}
          target="_blank"
          rel="noopener noreferrer"
          className="w-full inline-flex items-center justify-center gap-2 text-xs text-zinc-400 hover:text-zinc-200"
        >
          <MessageCircle className="w-3.5 h-3.5" />
          {t('team.shareWhatsApp')}
        </a>
      )}
      <Button fullWidth onClick={onDone}>
        {t('common.close')}
      </Button>
    </div>
  );
};
