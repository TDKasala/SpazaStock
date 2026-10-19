import React, { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useVisualViewport } from '../../hooks/useVisualViewport';
import { scrollFieldIntoView } from '../../lib/scrollFieldIntoView';

export interface DialogProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}

/** Matches Tailwind's `sm` breakpoint: phones get the keyboard-aware sheet. */
const PHONE_QUERY = '(max-width: 639px)';
/** A visible area this much shorter than the window is the on-screen keyboard. */
const KEYBOARD_OPEN_PX = 80;
const KEYBOARD_SETTLE_MS = 300;
const CLOSED_SHEET_RATIO = 0.85;

function usePhoneLayout(): boolean {
  const [phone, setPhone] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(PHONE_QUERY).matches
  );

  useEffect(() => {
    const media = window.matchMedia(PHONE_QUERY);
    const update = () => setPhone(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  return phone;
}

export const Dialog: React.FC<DialogProps> = ({
  isOpen,
  onClose,
  title,
  description,
  children,
  footer,
}) => {
  const phone = usePhoneLayout();
  const viewport = useVisualViewport(isOpen && phone);
  const overlayRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const activeField = useRef<HTMLElement | null>(null);
  const settleTimer = useRef<number | null>(null);

  const scrollActive = useCallback(() => {
    const field = activeField.current;
    const container = bodyRef.current;
    if (!field || !container || !container.contains(field)) return;
    scrollFieldIntoView(field, container);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const htmlOverflow = document.documentElement.style.overflow;
    const bodyOverflow = document.body.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.documentElement.style.overflow = htmlOverflow;
      document.body.style.overflow = bodyOverflow;
      window.removeEventListener('keydown', handleKeyDown);
      activeField.current = null;
    };
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen) return;
    const root = overlayRef.current;
    if (!root) return;
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.matches('input, textarea, select')) return;
      activeField.current = target;
      scrollActive();
      if (settleTimer.current != null) window.clearTimeout(settleTimer.current);
      settleTimer.current = window.setTimeout(() => {
        settleTimer.current = null;
        scrollActive();
      }, KEYBOARD_SETTLE_MS);
    };
    root.addEventListener('focusin', onFocusIn);
    return () => {
      root.removeEventListener('focusin', onFocusIn);
      if (settleTimer.current != null) window.clearTimeout(settleTimer.current);
    };
  }, [isOpen, scrollActive]);

  useEffect(() => {
    if (!isOpen || !viewport) return;
    scrollActive();
  }, [isOpen, viewport, scrollActive]);

  if (!isOpen) return null;

  const keyboardOpen = viewport != null && window.innerHeight - viewport.height > KEYBOARD_OPEN_PX;
  const overlayStyle = viewport
    ? { top: viewport.offsetTop, height: viewport.height, bottom: 'auto' as const }
    : undefined;
  const sheetStyle = viewport
    ? { maxHeight: keyboardOpen ? viewport.height : Math.round(viewport.height * CLOSED_SHEET_RATIO) }
    : undefined;

  return (
    <div
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="dialog-title"
      data-testid="dialog-overlay"
      style={overlayStyle}
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/75 backdrop-blur-sm animate-in fade-in duration-200 overscroll-none"
    >
      {/* Backdrop click area */}
      <div className="absolute inset-0" onClick={onClose} aria-hidden="true" />

      {/* Modal Dialog Box */}
      <div
        data-testid="dialog-sheet"
        style={sheetStyle}
        className="relative w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-t-3xl sm:rounded-2xl p-3 sm:p-6 shadow-2xl z-10 flex flex-col overflow-hidden max-h-[min(85dvh,calc(100dvh-env(safe-area-inset-bottom)))]"
      >
        {/* Mobile handle indicator */}
        <div className="w-12 h-1.5 bg-zinc-700/60 rounded-full mx-auto mb-3 shrink-0 sm:hidden" />

        {/* Dialog Header */}
        <div className="flex items-start justify-between gap-4 mb-3 sm:mb-4 shrink-0">
          <div>
            <h2 id="dialog-title" className="text-lg font-semibold text-zinc-100">
              {title}
            </h2>
            {description && (
              <p className="text-xs text-zinc-400 mt-1 leading-relaxed">
                {description}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            aria-label="Close dialog"
            className="p-1.5 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 rounded-lg transition-colors shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Dialog Content */}
        <div ref={bodyRef} data-testid="dialog-body" className="py-2 text-sm text-zinc-300 min-h-0 overflow-y-auto overscroll-contain">
          {children}
        </div>

        {/* Dialog Footer */}
        {footer && (
          <div className="mt-3 sm:mt-6 pt-3 sm:pt-4 border-t border-zinc-800/80 flex items-center justify-end gap-3 shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
};
