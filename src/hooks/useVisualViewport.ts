import { useEffect, useState } from 'react';

export interface ViewportBox {
  height: number;
  offsetTop: number;
}

/** The part of the page the user can actually see: excludes the on-screen keyboard and browser bars. */
export function readVisualViewport(win: Window = window): ViewportBox | null {
  const vv = win.visualViewport;
  if (vv && vv.height > 0) {
    return { height: Math.round(vv.height), offsetTop: Math.round(vv.offsetTop) };
  }
  // Android Chrome and iOS Safari expose visualViewport. Older browsers only resize the window.
  if (win.innerHeight > 0) return { height: Math.round(win.innerHeight), offsetTop: 0 };
  return null;
}

/**
 * Tracks the visual viewport while `enabled`. Android Chrome and iOS Safari open the keyboard over
 * the page without resizing it, so a full-screen overlay sized from this stays above the keyboard.
 * Without the Visual Viewport API, falls back to the window height and its resize event.
 * Returns null when disabled.
 */
export function useVisualViewport(enabled: boolean): ViewportBox | null {
  const [box, setBox] = useState<ViewportBox | null>(null);

  useEffect(() => {
    if (!enabled) {
      setBox(null);
      return;
    }
    const vv = window.visualViewport;
    const update = () => {
      const next = readVisualViewport();
      setBox((prev) =>
        prev && next && prev.height === next.height && prev.offsetTop === next.offsetTop ? prev : next
      );
    };
    update();
    if (vv) {
      vv.addEventListener('resize', update);
      vv.addEventListener('scroll', update);
    } else {
      window.addEventListener('resize', update);
    }
    return () => {
      vv?.removeEventListener('resize', update);
      vv?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [enabled]);

  return enabled ? box : null;
}
