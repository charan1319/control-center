import { useState, useEffect, useCallback, useRef } from 'react';

interface UseApiResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useApi<T>(
  fetcher: (() => Promise<T>) | null,
  options?: {
    refreshInterval?: number;
    enabled?: boolean;
  }
): UseApiResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const hasFetched = useRef(false);
  const enabled = options?.enabled ?? true;

  const doFetch = useCallback(async () => {
    if (!fetcher || !enabled) return;

    // Only show loading on first fetch
    if (!hasFetched.current) setLoading(true);

    try {
      const result = await fetcher();
      setData(result);
      setError(null);
      hasFetched.current = true;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [fetcher, enabled]);

  useEffect(() => {
    hasFetched.current = false;
    doFetch();

    const interval = options?.refreshInterval;
    if (!interval || !enabled) return;

    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        doFetch();
      }
    }, interval);

    return () => clearInterval(timer);
  }, [doFetch, options?.refreshInterval, enabled]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  return { data, loading, error, refresh: doFetch };
}
