/**
 * useScheduleLegendCollapsed — Schedule view legend overlay collapsed state (#474, ADR-0064).
 *
 * Persists whether the floating legend on the Gantt canvas is collapsed (chip only)
 * or expanded (chip + body). State is per-browser via localStorage and synchronized
 * across tabs via the StorageEvent. Mirrors the persistence shape used by
 * useBoardToolbarPrefs (ADR-0057 child B).
 */
import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'trueppm.schedule.legend.collapsed.v1';

function read(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function write(collapsed: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(collapsed));
  } catch {
    /* localStorage unavailable — degrade silently to in-memory state */
  }
}

export function useScheduleLegendCollapsed(): {
  collapsed: boolean;
  toggle: () => void;
  setCollapsed: (next: boolean) => void;
} {
  const [collapsed, setCollapsedState] = useState<boolean>(() => read());

  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY) setCollapsedState(read());
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setCollapsed = useCallback((next: boolean) => {
    write(next);
    setCollapsedState(next);
  }, []);

  const toggle = useCallback(() => {
    setCollapsedState((prev) => {
      const next = !prev;
      write(next);
      return next;
    });
  }, []);

  return { collapsed, toggle, setCollapsed };
}
