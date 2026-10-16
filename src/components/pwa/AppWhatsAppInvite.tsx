import React from 'react';
import { MessageCircle } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { buildAppLink, whatsappShareUrl } from '../../lib/invite';

export interface AppWhatsAppInviteProps {
  /** When set (e.g. shop owner name on signup), personalizes the invite message. */
  inviterName?: string;
  className?: string;
  /** Icon-only control for the app header. */
  compact?: boolean;
}

/** Opens WhatsApp with a pre-filled message linking to this SpazaStock install. */
export const AppWhatsAppInvite: React.FC<AppWhatsAppInviteProps> = ({
  inviterName,
  className = '',
  compact = false,
}) => {
  const { t } = useLanguage();
  const link = buildAppLink();
  const text = inviterName
    ? t('auth.appInviteTextNamed', { inviter: inviterName, link })
    : t('auth.appInviteText', { link });

  return (
    <a
      href={whatsappShareUrl(text)}
      target="_blank"
      rel="noopener noreferrer"
      title={t('auth.shareAppWhatsApp')}
      aria-label={t('auth.shareAppWhatsApp')}
      className={
        compact
          ? `inline-flex items-center justify-center px-2.5 py-1.5 rounded-lg border border-[#25D366]/40 bg-[#25D366]/15 hover:bg-[#25D366]/25 text-emerald-100 transition-colors ${className}`
          : `w-full inline-flex items-center justify-center gap-2 min-h-[44px] rounded-xl text-sm font-semibold bg-[#25D366]/15 hover:bg-[#25D366]/25 text-emerald-100 border border-[#25D366]/40 transition-colors ${className}`
      }
    >
      <MessageCircle className="w-4 h-4 shrink-0" aria-hidden />
      {!compact && t('auth.shareAppWhatsApp')}
    </a>
  );
};
