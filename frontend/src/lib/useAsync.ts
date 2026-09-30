import { useCallback, useEffect, useRef, useState } from "react";

/** Carga datos y los recarga cuando cambian las dependencias. Ignora respuestas viejas. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const counter = useRef(0);

  const reload = useCallback(() => {
    const id = ++counter.current;
    setLoading(true);
    fn()
      .then((value) => {
        if (id === counter.current) {
          setData(value);
          setError(null);
        }
      })
      .catch((err: Error) => id === counter.current && setError(err.message))
      .finally(() => id === counter.current && setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(reload, [reload]);
  return { data, error, loading, reload, setData };
}
