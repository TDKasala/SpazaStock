import React, { useEffect, useMemo, useState } from 'react';
import { Settings2, X } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { useShop } from '../../context/ShopContext';
import { DEFAULT_TIMEZONE, MAX_REMINDER_DAYS, normalizeReminderDays } from '../../lib/expiry';
import { canManageExpiry } from '../../lib/shopSettings';
import { Button } from '../ui/Button';

function timezoneOptions(current: string): string[] {
  const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone');
  const list = supported && supported.length > 0 ? supported : [DEFAULT_TIMEZONE, 'UTC'];
  return list.includes(current) ? list : [current, ...list];
}

/** Owners and managers choose the reminder days and the shop's time zone; staff see them. */
export const ReminderSettings: React.FC = () => {
  const { t } = useLanguage();
  const { settings, updateAlertSettings } = useShop();
  const [days, setDays] = useState<number[]>(settings.reminderDays);
  const [timezone, setTimezone] = useState(settings.timezone);
  const [newDay, setNewDay] = useState('');
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const zones = useMemo(() => timezoneOptions(settings.timezone), [settings.timezone]);

  useEffect(() => {
    setDays(settings.reminderDays);
    setTimezone(settings.timezone);
  }, [settings.reminderDays, settings.timezone]);

  if (!canManageExpiry(settings.role)) {
    return (
      <p className="text-[11px] text-zinc-400 px-1">
        {t('expiry.settingsReadOnly', { days: settings.reminderDays.join(', ') })}
      </p>
    );
  }

  const addDay = () => {
    const value = Number(newDay);
    const next = normalizeReminderDays([...days, value]);
    if (!next) {
      setMessage({ tone: 'error', text: t('expiry.invalidDays') });
      return;
    }
    setDays(next);
    setNewDay('');
    setMessage(null);
  };

  const save = async () => {
    const normalized = normalizeReminderDays(days);
    if (!normalized) {
      setMessage({ tone: 'error', text: t('expiry.invalidDays') });
      return;
    }
    setIsSaving(true);
    try {
      const { error } = await updateAlertSettings(normalized, timezone);
      if (!error) setMessage({ tone: 'ok', text: t('expiry.settingsSaved') });
      else if (error === 'invalid_days') setMessage({ tone: 'error', text: t('expiry.invalidDays') });
      else if (error === 'invalid_timezone') setMessage({ tone: 'error', text: t('expiry.invalidTimezone') });
      else setMessage({ tone: 'error', text: t('expiry.settingsFailed') });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <details className="rounded-2xl border border-zinc-800 bg-zinc-950 p-3.5 group">
      <summary className="text-xs font-semibold text-zinc-200 flex items-center gap-1.5 cursor-pointer list-none">
        <Settings2 className="w-3.5 h-3.5 text-zinc-400" />
        {t('expiry.settingsTitle')}
        <span className="text-zinc-500 font-normal">({settings.reminderDays.join(', ')})</span>
      </summary>

      <div className="mt-3 space-y-3">
        <p className="text-[11px] text-zinc-400">{t('expiry.settingsHint')}</p>
        <div className="flex flex-wrap gap-1.5">
          {days.map((d) => (
            <span
              key={d}
              className="inline-flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-full bg-zinc-800 text-xs text-zinc-100 border border-zinc-700"
            >
              {t('expiry.daysChip', { count: d })}
              <button
                onClick={() => setDays(days.filter((x) => x !== d))}
                disabled={days.length <= 1}
                aria-label={t('expiry.removeDay', { count: d })}
                className="p-0.5 rounded-full hover:bg-zinc-700 disabled:opacity-40"
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
        {days.length < MAX_REMINDER_DAYS && (
          <div className="flex gap-2">
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={180}
              value={newDay}
              placeholder={t('expiry.dayPlaceholder')}
              onChange={(e) => setNewDay(e.target.value)}
              className="w-24 bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-sm text-zinc-100"
            />
            <Button onClick={addDay} variant="secondary" size="sm">
              {t('expiry.addDay')}
            </Button>
          </div>
        )}

        <label className="block text-xs text-zinc-300 space-y-1.5">
          <span>{t('expiry.timezoneLabel')}</span>
          <select
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2.5 text-sm text-zinc-100"
          >
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </label>

        {message && (
          <p className={`text-xs ${message.tone === 'ok' ? 'text-emerald-400' : 'text-rose-400'}`}>{message.text}</p>
        )}
        <Button onClick={() => void save()} isLoading={isSaving} size="sm" fullWidth>
          {t('expiry.saveSettings')}
        </Button>
      </div>
    </details>
  );
};
