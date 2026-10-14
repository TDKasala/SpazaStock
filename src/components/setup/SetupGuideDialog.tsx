import React from 'react';
import { CheckCircle, ExternalLink, AlertTriangle } from 'lucide-react';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { envConfig } from '../../lib/env';
import { isSupabaseConfigured } from '../../lib/supabase';
import { useLanguage } from '../../context/LanguageContext';

export interface SetupGuideDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export const SetupGuideDialog: React.FC<SetupGuideDialogProps> = ({ isOpen, onClose }) => {
  const { t, dict } = useLanguage();
  const isConfigured = isSupabaseConfigured();

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={t('setup.guideTitle')}
      description={t('setup.guideDescription')}
      footer={
        <Button onClick={onClose} variant="primary" fullWidth>
          {t('common.close')}
        </Button>
      }
    >
      <div className="space-y-4 py-2">
        <div
          className={`p-3.5 rounded-xl border flex items-center gap-3 ${
            isConfigured ? 'bg-emerald-950/40 border-emerald-800 text-emerald-200' : 'bg-zinc-950 border-zinc-800 text-zinc-300'
          }`}
        >
          {isConfigured ? (
            <CheckCircle className="w-5 h-5 text-emerald-400 shrink-0" />
          ) : (
            <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0" />
          )}
          <div className="text-xs">
            <span className="font-semibold block">
              {isConfigured ? t('setup.statusConfigured') : t('setup.statusDeviceOnly')}
            </span>
            <span className="text-zinc-400">
              {isConfigured ? t('setup.statusConfiguredDetail') : t('setup.statusDeviceOnlyDetail')}
            </span>
          </div>
        </div>

        {envConfig.errors.length > 0 && (
          <div className="bg-zinc-950 p-3 rounded-xl border border-zinc-800 space-y-1">
            <span className="text-xs font-semibold text-zinc-300 block">{t('setup.diagnostics')}</span>
            <ul className="text-[11px] text-amber-400/90 space-y-1 list-disc list-inside">
              {envConfig.errors.map((err) => (
                <li key={err}>{err}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="space-y-2.5">
          <h4 className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">{t('setup.stepsHeading')}</h4>
          <ol className="text-xs text-zinc-300 space-y-2 list-decimal list-inside pl-1">
            {dict.setup.guideSteps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <a
            href="https://supabase.com/dashboard"
            target="_blank"
            rel="noreferrer"
            className="text-xs text-emerald-400 inline-flex items-center gap-1 hover:underline font-medium"
          >
            supabase.com <ExternalLink className="w-3 h-3" />
          </a>
        </div>
      </div>
    </Dialog>
  );
};
