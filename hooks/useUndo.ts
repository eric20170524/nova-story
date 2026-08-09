import { useState, useCallback } from 'react';

/** Simple present/past/future undo stack for editor content. */
export function useUndo<T>(initialPresent: T) {
  const [past, setPast] = useState<T[]>([]);
  const [present, setPresent] = useState<T>(initialPresent);
  const [future, setFuture] = useState<T[]>([]);

  const canUndo = past.length > 0;
  const canRedo = future.length > 0;

  const undo = useCallback(() => {
    setPast((p) => {
      if (p.length === 0) return p;
      const previous = p[p.length - 1];
      setPresent((curr) => {
        setFuture((f) => [curr, ...f]);
        return previous;
      });
      return p.slice(0, -1);
    });
  }, []);

  const redo = useCallback(() => {
    setFuture((f) => {
      if (f.length === 0) return f;
      const next = f[0];
      setPresent((curr) => {
        setPast((p) => [...p, curr]);
        return next;
      });
      return f.slice(1);
    });
  }, []);

  const set = useCallback((newPresent: T) => {
    setPresent((curr) => {
      if (Object.is(newPresent, curr)) return curr;
      setPast((p) => [...p, curr]);
      setFuture([]);
      return newPresent;
    });
  }, []);

  const setWithoutHistory = useCallback((newPresent: T | ((prev: T) => T)) => {
    setPresent((prev) =>
      typeof newPresent === 'function'
        ? (newPresent as (prev: T) => T)(prev)
        : newPresent
    );
    setPast([]);
    setFuture([]);
  }, []);

  return [present, set, undo, redo, canUndo, canRedo, setWithoutHistory] as const;
}
