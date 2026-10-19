import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Dialog } from '../components/ui/Dialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let originalMatchMedia: typeof window.matchMedia;

function setPhone(phone: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: phone && query === '(max-width: 639px)',
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

function setInnerHeight(height: number) {
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
}

function setVisualViewport(height: number, offsetTop = 0) {
  const viewport = Object.assign(new EventTarget(), { height, offsetTop });
  Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true });
  return viewport;
}

function rect(top: number, height: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    left: 0,
    right: 200,
    bottom: top + height,
    width: 200,
    height,
    toJSON() {
      return {};
    },
  } as DOMRect;
}

async function render(isOpen: boolean) {
  await act(async () => {
    root.render(
      <Dialog
        isOpen={isOpen}
        onClose={() => undefined}
        title="Add stock"
        footer={<button type="submit">Save</button>}
      >
        <div role="alert">Enter a quantity</div>
        <input aria-label="Quantity" />
      </Dialog>
    );
  });
}

beforeEach(() => {
  originalMatchMedia = window.matchMedia;
  setInnerHeight(800);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.matchMedia = originalMatchMedia;
  document.body.style.overflow = '';
  document.documentElement.style.overflow = '';
});

describe('dialog above the keyboard', () => {
  it('pins a phone dialog to the visible viewport and keeps the footer outside the scroller', async () => {
    setPhone(true);
    const viewport = setVisualViewport(360, 24);
    await render(true);

    const overlay = container.querySelector<HTMLElement>('[data-testid="dialog-overlay"]')!;
    const sheet = container.querySelector<HTMLElement>('[data-testid="dialog-sheet"]')!;
    const body = container.querySelector<HTMLElement>('[data-testid="dialog-body"]')!;
    const save = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Save')!;

    expect(overlay.style.height).toBe('360px');
    expect(overlay.style.top).toBe('24px');
    expect(sheet.style.maxHeight).toBe('360px');
    expect(body.contains(save)).toBe(false);
    expect(sheet.contains(save)).toBe(true);

    await act(async () => {
      viewport.height = 800;
      viewport.offsetTop = 0;
      viewport.dispatchEvent(new Event('resize'));
    });
    expect(overlay.style.height).toBe('800px');
    expect(sheet.style.maxHeight).toBe('680px');
  });

  it('leaves the desktop dialog on the normal layout', async () => {
    setPhone(false);
    setVisualViewport(360, 24);
    await render(true);
    const overlay = container.querySelector<HTMLElement>('[data-testid="dialog-overlay"]')!;
    const sheet = container.querySelector<HTMLElement>('[data-testid="dialog-sheet"]')!;
    expect(overlay.style.height).toBe('');
    expect(sheet.style.maxHeight).toBe('');
  });

  it('scrolls the focused field and the error above it inside the dialog', async () => {
    setPhone(true);
    setVisualViewport(360, 0);
    await render(true);

    const body = container.querySelector<HTMLElement>('[data-testid="dialog-body"]')!;
    const alert = container.querySelector<HTMLElement>('[role="alert"]')!;
    const input = container.querySelector<HTMLInputElement>('input')!;
    body.getBoundingClientRect = () => rect(0, 200);
    alert.getBoundingClientRect = () => rect(400, 40);
    input.getBoundingClientRect = () => rect(460, 40);
    body.scrollTo = ((options?: ScrollToOptions) => {
      body.scrollTop = typeof options === 'object' && options ? (options.top ?? 0) : 0;
    }) as HTMLElement['scrollTo'];

    await act(async () => {
      input.focus();
    });

    expect(body.scrollTop).toBe(312);
  });

  it('locks page scrolling while open and restores it on close', async () => {
    setPhone(true);
    setVisualViewport(800, 0);
    document.body.style.overflow = 'auto';
    document.documentElement.style.overflow = 'scroll';
    await render(true);
    expect(document.body.style.overflow).toBe('hidden');
    expect(document.documentElement.style.overflow).toBe('hidden');
    await render(false);
    expect(document.body.style.overflow).toBe('auto');
    expect(document.documentElement.style.overflow).toBe('scroll');
  });
});
