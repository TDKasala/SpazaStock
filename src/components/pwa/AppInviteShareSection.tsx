import React from 'react';
import { useLanguage } from '../../context/LanguageContext';
import { AppWhatsAppInvite } from './AppWhatsAppInvite';

export interface AppInviteShareSectionProps {
  inviterName?: string;
  className?: string;
}

/** Hint plus WhatsApp share button for inviting other shop owners to SpazaStock. */
export const AppInviteShareSection: React.FC<AppInviteShareSectionProps> = ({ inviterName, className = '' }) => {
  const { t } = useLanguage();
  return (
    <div className={`space-y-2.5 ${className}`}>
      <p className="text-xs text-zinc-400 leading-relaxed text-center sm:text-left">{t('auth.appInviteHint')}</p>
      <AppWhatsAppInvite inviterName={inviterName} />
    </div>
  );
};
