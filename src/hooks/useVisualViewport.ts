import { useEffect, useState } from 'react';

export interface ViewportBox {
  height: number;
  offsetTop: number;
}

/** The part of the page the user can actually see: excludes the on-screen keyboard and browser bars. */
export function readVisualViewport(win: Window = window): ViewportBox | null {
  const vv = win.visualViewport;
  if (!vv || !(vv.height > 0)) return null;
  return { height: Math.round(vv.height), offsetTop: Math.round(vv.offsetTop) };
}

/**
 * Tracks the visual viewport while `enabled`. Android Chrome and iOS Safari open the keyboard over
 * the page without resizing it, so a full-screen overlay sized from this stays above the keyboard.
 * Returns null when disabled or when the browser has no visual viewport API.
 */
export function useVisualViewport(enabled: boolean): ViewportBox | null {
  const [box, setBox] = useState<ViewportBox | null>(null);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!enabled || !vv) {
      setBox(null);
      return;
    }
    const update = () => {
      const next = readVisualViewport();
      setBox((prev) =>
        prev && next && prev.height === next.height && prev.offsetTop === next.offsetTop ? prev : next
      );
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, [enabled]);

  return enabled ? box : null;
}
