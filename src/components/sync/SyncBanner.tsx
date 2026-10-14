import React from 'react';
import { AlertTriangle, CloudOff, RefreshCw } from 'lucide-react';
import { useSyncStatus } from '../../hooks/useSyncStatus';
import { useLanguage } from '../../context/LanguageContext';
import { Button } from '../ui/Button';

/** Shows queued or failed changes so the shopkeeper knows what hasn't reached the cloud yet. */
export const SyncBanner: React.FC = () => {
  const { status, syncNow, retryFailed } = useSyncStatus();
  const { t } = useLanguage();

  if (!status.enabled) return null;

  // SuspendedNotice explains a suspension; repeating the queue count here would only alarm.
  if (status.blocked === 'suspended') return null;

  if (status.blocked === 'plan_limit') {
    return (
      <div className="mb-4 p-3.5 bg-amber-950/40 border border-amber-800/80 rounded-2xl flex items-start gap-2.5 text-amber-200">
        <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
        <span className="text-xs font-medium">{t('sync.planLimit')}</span>
      </div>
    );
  }

  if (status.failed > 0) {
    return (
      <div className="mb-4 p-3.5 bg-rose-950/40 border border-rose-800/80 rounded-2xl flex items-center justify-between gap-3 text-rose-200">
        <div className="flex items-center gap-2.5 min-w-0">
          <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
          <span className="text-xs font-medium">{t('sync.failedCount', { count: status.failed })}</span>
        </div>
        <Button
          onClick={() => void retryFailed()}
          variant="secondary"
          size="sm"
          className="h-8 text-xs shrink-0"
          isLoading={status.isSyncing}
          leftIcon={<RefreshCw className="w-3.5 h-3.5" />}
        >
          {t('common.retry')}
        </Button>
      </div>
    );
  }

  if (status.pending > 0) {
    return (
      <div className="mb-4 p-3.5 bg-amber-950/40 border border-amber-800/80 rounded-2xl flex items-center justify-between gap-3 text-amber-200">
        <div className="flex items-center gap-2.5 min-w-0">
          <CloudOff className="w-4 h-4 text-amber-400 shrink-0" />
          <span className="text-xs font-medium">
            {status.isOnline
              ? t('sync.pendingCount', { count: status.pending })
              : t('sync.pendingOffline', { count: status.pending })}
          </span>
        </div>
        {status.isOnline && (
          <Button
            onClick={() => void syncNow()}
            variant="secondary"
            size="sm"
            className="h-8 text-xs shrink-0"
            isLoading={status.isSyncing}
            leftIcon={<RefreshCw className="w-3.5 h-3.5" />}
          >
            {t('sync.syncNow')}
          </Button>
        )}
      </div>
    );
  }

  return null;
};
