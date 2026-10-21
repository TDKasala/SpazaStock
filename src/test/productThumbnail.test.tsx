import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProductThumbnail } from '../components/stock/ProductThumbnail';
import { emitDataChanged } from '../lib/events';

vi.mock('../services/productImageService', () => ({
  PRODUCT_IMAGE_BUCKET: 'product-images',
  getCachedImage: vi.fn(async () => ({
    path: 'shop/picture.webp',
    shopId: 'shop',
    bytes: new Uint8Array([1, 2, 3, 4]).buffer,
    mimeType: 'image/webp',
    pending: false,
    cachedAt: '2026-10-21T00:00:00.000Z',
  })),
  cacheImage: vi.fn(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let revoked: string[];
let restoreUrl: () => void;

beforeEach(() => {
  revoked = [];
  const create = URL.createObjectURL.bind(URL);
  const revoke = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = (object: Blob | MediaSource) => create(object);
  URL.revokeObjectURL = (url: string) => {
    revoked.push(url);
    revoke(url);
  };
  restoreUrl = () => {
    URL.createObjectURL = create;
    URL.revokeObjectURL = revoke;
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  restoreUrl();
});

async function show(path = 'shop/picture.webp') {
  await act(async () => {
    root.render(<ProductThumbnail path={path} size="form" alt="Meal" />);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe('product pictures', () => {
  it('keeps the picture address when shop data changes', async () => {
    await show();
    const img = container.querySelector('img');
    expect(img?.getAttribute('src')?.startsWith('blob:')).toBe(true);
    const src = img?.getAttribute('src');

    await act(async () => {
      emitDataChanged('remote');
      await Promise.resolve();
    });

    expect(container.querySelector('img')?.getAttribute('src')).toBe(src);
    expect(revoked).not.toContain(src);
  });

  it('does not drop the picture address in the same turn the thumbnail goes away', async () => {
    await show();
    const src = container.querySelector('img')?.getAttribute('src');
    expect(src).toBeTruthy();

    await act(async () => {
      root.render(null);
    });
    expect(revoked).not.toContain(src);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2100));
    });
    expect(revoked).toContain(src);
  });
});
