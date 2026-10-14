import { useCallback, useEffect, useRef, useState } from 'react';

export interface AdminQuery<T> {
  data: T | null;
  error: unknown;
  isLoading: boolean;
  /** When the current data arrived. */
  loadedAt: Date | null;
  reload: () => void;
}

/**
 * Runs `load` whenever `key` changes or reload() is called. A response that arrives after a newer
 * request started is ignored, so filters typed quickly never show stale rows.
 */
export function useAdminQuery<T>(key: string, load: () => Promise<T>): AdminQuery<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);
  const [token, setToken] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    loadRef
      .current()
      .then((result) => {
        if (!active) return;
        setData(result);
        setError(null);
        setLoadedAt(new Date());
      })
      .catch((err: unknown) => {
        if (active) setError(err);
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [key, token]);

  const reload = useCallback(() => setToken((n) => n + 1), []);
  return { data, error, isLoading, loadedAt, reload };
}
