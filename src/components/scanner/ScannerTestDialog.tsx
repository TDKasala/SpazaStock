import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog } from '../ui/Dialog';
import { useLanguage } from '../../context/LanguageContext';
import { attachGlobalHidListener } from '../../lib/scanner/hid';
import { visualiseControlChars, parseGs1 } from '../../lib/barcode/gs1';
import { Button } from '../ui/Button';
import { BadgeInfo, Keyboard } from 'lucide-react';
import { ScanInput } from './ScanInput';

export interface ScannerTestDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export const ScannerTestDialog: React.FC<ScannerTestDialogProps> = ({ isOpen, onClose }) => {
  const { t } = useLanguage();
  const [raw, setRaw] = useState<string>('');
  const [display, setDisplay] = useState<string>('');
  const [parsed, setParsed] = useState<ReturnType<typeof parseGs1> | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const detach = attachGlobalHidListener(
      (code) => {
        setRaw(code);
        setDisplay(visualiseControlChars(code));
        setParsed(parseGs1(code));
      },
      { active: true, feedback: false }
    );
    return detach;
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) setTimeout(() => logRef.current?.scrollIntoView({ block: 'end' }), 50);
  }, [isOpen, display]);

  if (!isOpen) return null;

  const details = useMemo(() => {
    if (!parsed) return null;
    if (parsed.kind === 'plain') return <p className="text-xs text-zinc-300">{t('scannerTest.plain', { code: parsed.code })}</p>;
    return (
      <div className="text-xs text-zinc-300 space-y-1.5">
        <p><strong>GTIN-14:</strong> {parsed.gtin14 ?? '—'}</p>
        <p><strong>Lookup:</strong> {parsed.lookupBarcodes.join(', ') || '—'}</p>
        <p><strong>Expiry:</strong> {parsed.expiry ?? '—'}</p>
        <p><strong>Lot:</strong> {parsed.lot ?? '—'}</p>
      </div>
    );
  }, [parsed, t]);

  return (
    <Dialog
      isOpen
      onClose={onClose}
      title={t('scannerTest.title')}
      description={t('scannerTest.subtitle')}
      footer={<Button onClick={onClose} variant="secondary" size="md" className="w-full">{t('common.close')}</Button>}
    >
      <div className="space-y-4 py-1">
        <ScanInput onScan={(code) => {
          setRaw(code);
          setDisplay(visualiseControlChars(code));
          setParsed(parseGs1(code));
        }} label={t('scanner.manualEntryTitle')} placeholder={t('scanner.manualEntryPlaceholder')} />

        <div className="p-3 bg-zinc-950 rounded-xl border border-zinc-800 text-xs">
          <div className="font-semibold text-zinc-400 mb-1">{t('scannerTest.rawInput')}</div>
          <div className="font-mono break-all text-zinc-200" data-testid="scanner-raw">{display || '—'}</div>
        </div>

        {details}

        <div className="p-3 bg-zinc-900/60 rounded-xl border border-zinc-800 text-xs text-zinc-300 space-y-2">
          <div className="flex items-center gap-2 font-semibold text-zinc-200">
            <BadgeInfo className="w-4 h-4" /> {t('scannerTest.tipsTitle')}
          </div>
          <ul className="list-disc list-inside space-y-1">
            <li>{t('scannerTest.tipHid')}</li>
            <li>{t('scannerTest.tipChrome')}</li>
            <li>{t('scannerTest.tipIos')}</li>
          </ul>
        </div>
      </div>
    </Dialog>
  );
};

