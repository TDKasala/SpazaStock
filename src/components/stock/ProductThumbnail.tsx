import React, { useEffect, useRef, useState } from 'react';
import { CloudOff, Package } from 'lucide-react';
import { onDataChanged } from '../../lib/events';
import { getSupabase } from '../../lib/supabase';
import { PRODUCT_IMAGE_BUCKET, cacheImage, getCachedImage } from '../../services/productImageService';

export type ThumbnailSize = 'sm' | 'md' | 'form' | 'lg';

const SIZE_CLASSES: Record<ThumbnailSize, string> = {
  sm: 'w-10 h-10 rounded-lg',
  md: 'w-16 h-16 rounded-xl',
  form: 'w-[72px] h-[72px] rounded-xl',
  lg: 'w-24 h-24 rounded-2xl',
};

/** One download per picture, however many thumbnails ask for it at once. */
const downloads = new Map<string, Promise<boolean>>();
/** A picture that could not be downloaded is not asked for again on every change. */
const failedAt = new Map<string, number>();
const RETRY_AFTER_MS = 5 * 60 * 1000;

function downloadOnce(path: string): Promise<boolean> {
  if (Date.now() - (failedAt.get(path) ?? 0) < RETRY_AFTER_MS) return Promise.resolve(false);
  let pending = downloads.get(path);
  if (!pending) {
    pending = (async () => {
      const client = getSupabase();
      if (!client) return false;
      const { data, error } = await client.storage.from(PRODUCT_IMAGE_BUCKET).download(path);
      if (error || !data) return false;
      await cacheImage(path, path.split('/')[0], await data.arrayBuffer(), data.type || 'image/webp');
      return true;
    })()
      .catch(() => false)
      .then((ok) => {
        if (!ok) failedAt.set(path, Date.now());
        return ok;
      })
      .finally(() => downloads.delete(path));
    downloads.set(path, pending);
  }
  return pending;
}

/**
 * The picture at `path` as an object URL, from the phone's cache or downloaded once (only when
 * `visible` and online), plus whether it is still waiting to upload.
 */
export function useProductImage(path: string | null | undefined, visible = true): { url: string | null; pending: boolean } {
  const [state, setState] = useState<{ url: string | null; pending: boolean }>({ url: null, pending: false });
  const [version, setVersion] = useState(0);

  useEffect(() => onDataChanged(() => setVersion((v) => v + 1)), []);

  useEffect(() => {
    if (!path) {
      setState({ url: null, pending: false });
      return;
    }
    let cancelled = false;
    let url: string | null = null;
    void (async () => {
      let cached = await getCachedImage(path);
      if (!cached && visible && navigator.onLine && (await downloadOnce(path))) cached = await getCachedImage(path);
      if (cancelled) return;
      if (!cached) {
        setState({ url: null, pending: false });
        return;
      }
      url = URL.createObjectURL(new Blob([cached.bytes], { type: cached.mimeType }));
      setState({ url, pending: cached.pending });
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [path, visible, version]);

  return state;
}

export interface ProductThumbnailProps {
  path: string | null | undefined;
  size?: ThumbnailSize;
  /** Shown instead of the picture, e.g. a preview of a picture that has not been saved yet. */
  previewUrl?: string | null;
  alt?: string;
  className?: string;
}

export const ProductThumbnail: React.FC<ProductThumbnailProps> = ({ path, size = 'sm', previewUrl, alt = '', className = '' }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(typeof IntersectionObserver === 'undefined');

  useEffect(() => {
    if (visible || !ref.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px' }
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [visible]);

  const { url, pending } = useProductImage(previewUrl ? null : path, visible);
  const src = previewUrl ?? url;

  return (
    <div
      ref={ref}
      className={`relative shrink-0 overflow-hidden bg-zinc-900 border border-zinc-800 flex items-center justify-center ${SIZE_CLASSES[size]} ${className}`}
    >
      {src ? (
        <img src={src} alt={alt} className="w-full h-full object-cover" loading="lazy" decoding="async" />
      ) : (
        <Package className="w-1/2 h-1/2 text-zinc-600" aria-hidden />
      )}
      {pending && !previewUrl && (
        <span className="absolute bottom-0.5 right-0.5 rounded-full bg-zinc-950/90 p-0.5">
          <CloudOff className="w-3 h-3 text-amber-400" aria-hidden />
        </span>
      )}
    </div>
  );
};
