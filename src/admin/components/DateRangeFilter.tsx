import React, { useState } from 'react';
import { Button } from '../../components/ui/Button';
import { useAdminI18n } from '../i18n';
import { customDefaults, RANGE_PRESETS, resolveRange, type DateRangeValue, type RangePreset } from '../range';

interface DateRangeFilterProps {
  value: DateRangeValue;
  onChange: (value: DateRangeValue) => void;
}

export const selectClass =
  'bg-zinc-900 border border-zinc-800 hover:border-zinc-700 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 focus:outline-none rounded-xl px-3 py-2 text-sm text-zinc-100 min-h-[40px]';

export const DateRangeFilter: React.FC<DateRangeFilterProps> = ({ value, onChange }) => {
  const { at } = useAdminI18n();
  const [draft, setDraft] = useState(() => ({
    fromDay: value.fromDay ?? customDefaults().fromDay,
    toDay: value.toDay ?? customDefaults().toDay,
  }));
  const customValid = resolveRange({ preset: 'custom', ...draft }) !== null;

  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="flex flex-col gap-1 text-xs text-zinc-400">
        {at('range.label')}
        <select
          className={selectClass}
          value={value.preset}
          onChange={(e) => {
            const preset = e.target.value as RangePreset;
            onChange(preset === 'custom' ? { preset, ...draft } : { preset });
          }}
        >
          {RANGE_PRESETS.map((preset) => (
            <option key={preset} value={preset}>
              {at(`range.presets.${preset}`)}
            </option>
          ))}
        </select>
      </label>
      {value.preset === 'custom' && (
        <>
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            {at('common.from')}
            <input
              type="date"
              className={selectClass}
              value={draft.fromDay}
              onChange={(e) => setDraft((d) => ({ ...d, fromDay: e.target.value }))}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            {at('common.to')}
            <input
              type="date"
              className={selectClass}
              value={draft.toDay}
              onChange={(e) => setDraft((d) => ({ ...d, toDay: e.target.value }))}
            />
          </label>
          <Button size="sm" variant="secondary" disabled={!customValid} onClick={() => onChange({ preset: 'custom', ...draft })}>
            {at('common.apply')}
          </Button>
          {!customValid && <p className="w-full text-xs text-rose-400">{at('range.invalid')}</p>}
        </>
      )}
    </div>
  );
};
