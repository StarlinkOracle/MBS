import { useCallback, useEffect, useMemo, useState } from "react";

const cache = new Map();

const isCacheFresh = (entry, cacheTime) => {
  if (!entry) {
    return false;
  }

  return Date.now() - entry.timestamp < cacheTime;
};

export const useQuery = (key, queryFn, options = {}) => {
  const { enabled = true, cacheTime = 30000, initialData } = options;
  const keyString = useMemo(() => JSON.stringify(key), [key]);

  const cached = cache.get(keyString);
  const [data, setData] = useState(
    isCacheFresh(cached, cacheTime) ? cached.data : initialData
  );
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(enabled);

  const run = useCallback(
    async ({ force = false } = {}) => {
      if (!enabled) {
        return;
      }

      if (!force) {
        const cachedEntry = cache.get(keyString);
        if (isCacheFresh(cachedEntry, cacheTime)) {
          setData(cachedEntry.data);
          setError(null);
          setLoading(false);
          return;
        }
      }

      const controller = new AbortController();
      setLoading(true);
      setError(null);

      try {
        const result = await queryFn({ signal: controller.signal });
        cache.set(keyString, { data: result, timestamp: Date.now() });
        setData(result);
      } catch (nextError) {
        if (!nextError?.isAbort) {
          setError(nextError);
        }
      } finally {
        setLoading(false);
      }

      return () => controller.abort();
    },
    [enabled, keyString, cacheTime, queryFn]
  );

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return undefined;
    }

    const controller = new AbortController();

    const fetchData = async () => {
      const cachedEntry = cache.get(keyString);

      if (isCacheFresh(cachedEntry, cacheTime)) {
        setData(cachedEntry.data);
        setLoading(false);
        setError(null);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const result = await queryFn({ signal: controller.signal });
        cache.set(keyString, { data: result, timestamp: Date.now() });
        setData(result);
      } catch (nextError) {
        if (!nextError?.isAbort) {
          setError(nextError);
        }
      } finally {
        setLoading(false);
      }
    };

    fetchData();

    return () => controller.abort();
  }, [keyString, queryFn, enabled, cacheTime]);

  const refetch = useCallback(async () => {
    cache.delete(keyString);
    await run({ force: true });
  }, [keyString, run]);

  return { data, loading, error, refetch };
};

export const clearQueryCache = () => cache.clear();
