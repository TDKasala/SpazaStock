import { describe, it, expect } from 'vitest';
import { readVisualViewport } from '../hooks/useVisualViewport';

const fakeWindow = (visualViewport: unknown) => ({ visualViewport }) as unknown as Window;

describe('visual viewport', () => {
  it('reports the visible height and offset in whole pixels', () => {
    expect(readVisualViewport(fakeWindow({ height: 431.6, offsetTop: 12.2 }))).toEqual({ height: 432, offsetTop: 12 });
  });

  it('returns nothing when the browser has no visual viewport or it has no size yet', () => {
    expect(readVisualViewport(fakeWindow(undefined))).toBeNull();
    expect(readVisualViewport(fakeWindow(null))).toBeNull();
    expect(readVisualViewport(fakeWindow({ height: 0, offsetTop: 0 }))).toBeNull();
  });
});
