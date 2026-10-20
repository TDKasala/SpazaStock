import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ShopFormFields } from '../components/shop/ShopFormFields';
import { LanguageProvider } from '../context/LanguageContext';
import { emptyShopForm, type ShopFormValues } from '../lib/shopDetails';

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

describe('shop location button', () => {
  it('fills the form from the phone GPS', async () => {
    let values = emptyShopForm();
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition: (success: (position: { coords: { latitude: number; longitude: number } }) => void) => {
          success({ coords: { latitude: -26.2041034, longitude: 28.0473056 } });
        },
      },
    });

    const render = () =>
      root.render(
        <LanguageProvider>
          <ShopFormFields values={values} errors={{}} onChange={(next: ShopFormValues) => (values = next)} />
        </LanguageProvider>
      );
    await act(async () => {
      render();
    });

    const button = [...container.querySelectorAll('button')].find((node) => node.textContent?.includes('Use my location'));
    await act(async () => {
      button?.click();
    });
    await act(async () => {
      render();
    });

    expect(values).toMatchObject({ latitude: -26.204103, longitude: 28.047306 });
    expect(container.textContent).toContain('Location set: -26.204103, 28.047306');
  });
});
