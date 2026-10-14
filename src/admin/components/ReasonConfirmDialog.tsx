import React, { useEffect, useState } from 'react';
import { Dialog } from '../../components/ui/Dialog';
import { Button } from '../../components/ui/Button';
import { ErrorMessage } from '../../components/ui/ErrorMessage';
import { useAdminI18n } from '../i18n';
import { adminErrorMessage } from '../api';

/** Same bounds as private.require_reason in the database. */
export const REASON_MIN = 10;
export const REASON_MAX = 500;

export function reasonIssue(reason: string): 'tooShort' | 'tooLong' | null {
  const length = reason.trim().length;
  if (length < REASON_MIN) return 'tooShort';
  if (length > REASON_MAX) return 'tooLong';
  return null;
}

export function confirmNameMatches(typed: string, name: string): boolean {
  return typed.trim().toLocaleLowerCase() === name.trim().toLocaleLowerCase();
}

interface ReasonConfirmDialogProps {
  isOpen: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  danger?: boolean;
  /** When set, the target's name must be typed before the action is allowed. */
  confirmName?: string;
  /** Extra inputs (e.g. a plan form); `canSubmit` reports whether they are complete. */
  children?: React.ReactNode;
  canSubmit?: boolean;
  /** Throws to keep the dialog open and show the error. */
  onConfirm: (reason: string) => Promise<void>;
  onClose: () => void;
}

export const ReasonConfirmDialog: React.FC<ReasonConfirmDialogProps> = ({
  isOpen,
  title,
  description,
  confirmLabel,
  danger = false,
  confirmName,
  children,
  canSubmit = true,
  onConfirm,
  onClose,
}) => {
  const { at } = useAdminI18n();
  const [reason, setReason] = useState('');
  const [typedName, setTypedName] = useState('');
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setReason('');
    setTypedName('');
    setTouched(false);
    setError(null);
  }, [isOpen]);

  const issue = reasonIssue(reason);
  const nameOk = !confirmName || confirmNameMatches(typedName, confirmName);
  const ready = issue === null && nameOk && canSubmit;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!ready) return;
    setIsBusy(true);
    setError(null);
    try {
      await onConfirm(reason.trim());
    } catch (err) {
      setError(adminErrorMessage(err, at));
    } finally {
      setIsBusy(false);
    }
  };

  const close = () => {
    if (!isBusy) onClose();
  };

  return (
    <Dialog isOpen={isOpen} onClose={close} title={title} description={description}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        {error && <ErrorMessage message={error} onDismiss={() => setError(null)} />}
        {children}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="admin-reason" className="text-xs font-medium text-zinc-300">
            {at('reason.label')}
          </label>
          <textarea
            id="admin-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onBlur={() => setTouched(true)}
            maxLength={REASON_MAX}
            rows={3}
            required
            aria-invalid={touched && issue !== null}
            aria-describedby="admin-reason-hint"
            placeholder={at('reason.placeholder')}
            className="w-full bg-zinc-900 border border-zinc-800 hover:border-zinc-700 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 focus:outline-none rounded-xl px-3.5 py-3 text-sm text-zinc-100 placeholder:text-zinc-500"
          />
          <span id="admin-reason-hint" className={`text-xs ${touched && issue ? 'text-rose-400' : 'text-zinc-500'}`}>
            {touched && issue === 'tooShort'
              ? at('reason.tooShort', { min: REASON_MIN })
              : at('reason.hint', { min: REASON_MIN, max: REASON_MAX })}
          </span>
        </div>
        {confirmName && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="admin-confirm-name" className="text-xs font-medium text-zinc-300">
              {at('reason.confirmLabel', { name: confirmName })}
            </label>
            <input
              id="admin-confirm-name"
              value={typedName}
              onChange={(e) => setTypedName(e.target.value)}
              autoComplete="off"
              aria-invalid={touched && !nameOk}
              className="w-full bg-zinc-900 border border-zinc-800 hover:border-zinc-700 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 focus:outline-none rounded-xl px-3.5 py-3 text-sm text-zinc-100"
            />
            {touched && !nameOk && <span className="text-xs text-rose-400">{at('reason.confirmMismatch')}</span>}
          </div>
        )}
        <div className="flex justify-end gap-3 pt-2">
          <Button type="button" variant="ghost" onClick={close} disabled={isBusy}>
            {at('common.cancel')}
          </Button>
          <Button type="submit" variant={danger ? 'danger' : 'primary'} isLoading={isBusy} disabled={!ready}>
            {confirmLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
};
