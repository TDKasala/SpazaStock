import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BottomNav } from '../components/layout/BottomNav';
import { LanguageProvider } from '../context/LanguageContext';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('Bottom navigation', () => {
  it('places the shopping list beside Alerts', async () => {
    await act(async () => {
      root.render(
        <LanguageProvider>
          <BottomNav currentTab="dashboard" onSelectTab={() => undefined} />
        </LanguageProvider>,
      );
    });

    const labels = [...container.querySelectorAll('button')].map((button) => button.textContent?.trim());
    expect(labels).toEqual(['Dashboard', 'Stock', 'Sales', 'Alerts', 'Shopping list', 'More']);
    expect(container.querySelector('.grid-cols-6')).not.toBeNull();
  });
});
