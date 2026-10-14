import React from 'react';
import { Database, Key, CheckCircle, ExternalLink, AlertTriangle } from 'lucide-react';
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
  const { t } = useLanguage();
  const isConfigured = isSupabaseConfigured();

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={t('setup.guideTitle')}
      description="SpazaStock connects directly to Supabase PostgreSQL for real-time inventory and sales tracking."
      footer={
        <Button onClick={onClose} variant="primary" fullWidth>
          {t('common.close')}
        </Button>
      }
    >
      <div className="space-y-4 py-2">
        {/* Status Pill */}
        <div className={`p-3.5 rounded-xl border flex items-center gap-3 ${
          isConfigured 
            ? 'bg-emerald-950/40 border-emerald-800 text-emerald-200' 
            : 'bg-zinc-950 border-zinc-800 text-zinc-300'
        }`}>
          {isConfigured ? (
            <CheckCircle className="w-5 h-5 text-emerald-400 shrink-0" />
          ) : (
            <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0" />
          )}
          <div className="text-xs">
            <span className="font-semibold block">
              {isConfigured ? 'Supabase Client Initialized' : 'Supabase Credentials Pending'}
            </span>
            <span className="text-zinc-400">
              {isConfigured 
                ? 'Your app is ready to perform authenticated operations.' 
                : 'Placeholder values detected in configuration.'}
            </span>
          </div>
        </div>

        {/* Validation Errors if any */}
        {envConfig.errors.length > 0 && (
          <div className="bg-zinc-950 p-3 rounded-xl border border-zinc-800 space-y-1">
            <span className="text-xs font-semibold text-zinc-300 block">Diagnostic Validation:</span>
            <ul className="text-[11px] text-amber-400/90 space-y-1 list-disc list-inside">
              {envConfig.errors.map((err, idx) => (
                <li key={idx}>{err}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Steps */}
        <div className="space-y-2.5">
          <h4 className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">
            Configuration Steps
          </h4>
          <ol className="text-xs text-zinc-300 space-y-2 list-decimal list-inside pl-1">
            <li>
              <span>Create or open your Supabase project at </span>
              <a
                href="https://supabase.com"
                target="_blank"
                rel="noreferrer"
                className="text-emerald-400 inline-flex items-center gap-1 hover:underline font-medium"
              >
                supabase.com <ExternalLink className="w-3 h-3" />
              </a>
            </li>
            <li>Go to <strong className="text-zinc-100">Project Settings &gt; API</strong>.</li>
            <li>Copy your <strong className="text-zinc-100">Project URL</strong> and <strong className="text-zinc-100">anon public key</strong>.</li>
            <li>
              Add them to your environment (e.g. <code className="bg-zinc-800 px-1 py-0.5 rounded text-emerald-300">.env.local</code>):
              <pre className="mt-2 p-2.5 bg-black rounded-lg text-[11px] font-mono text-zinc-300 border border-zinc-800 overflow-x-auto">
{`VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOi...`}
              </pre>
            </li>
            <li>Run <code className="bg-zinc-800 px-1 py-0.5 rounded text-emerald-300">npm run dev</code> to connect.</li>
          </ol>
        </div>

        <div className="bg-zinc-950 p-3 rounded-xl border border-zinc-800/80 flex items-start gap-2.5 text-xs text-zinc-400">
          <Key className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
          <span>No mock fake data is loaded. Once connected, your live database tables will be queried directly.</span>
        </div>
      </div>
    </Dialog>
  );
};
