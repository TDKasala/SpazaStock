import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MoreView } from '../components/views/MoreView';
import { LanguageProvider } from '../context/LanguageContext';

vi.mock('../context/ShopContext', () => ({
  useShop: () => ({ shop: { id: 'shop-1', name: 'Shop', role: 'owner' } }),
}));

vi.mock('../components/expiry/PushAlertsToggle', () => ({
  PushAlertsToggle: () => <div>Alerts</div>,
}));

vi.mock('../components/expiry/ReminderSettings', () => ({
  ReminderSettings: () => <div>Reminders</div>,
}));

vi.mock('../components/stock/StockLevelSettings', () => ({
  StockLevelSettings: () => <div>Levels</div>,
}));

vi.mock('../components/dashboard/StockIntelligenceCard', () => ({
  StockIntelligenceCard: () => <div>Intelligence</div>,
}));

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

describe('More page', () => {
  it('opens wholesale orders without a catalogue button', async () => {
    await act(async () => {
      root.render(
        <LanguageProvider>
          <MoreView
            lowStock={[]}
            products={[]}
            sales={[]}
            batches={[]}
            timezone="Africa/Johannesburg"
            isLoadingIntelligence={false}
          />
        </LanguageProvider>,
      );
    });

    const labels = [...container.querySelectorAll('button')].map((button) => button.textContent?.trim());
    expect(labels).toContain('Wholesale orders');
    expect(labels).not.toContain('Catalogue');
  });
});
