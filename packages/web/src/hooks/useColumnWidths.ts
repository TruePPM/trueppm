import { useState, useCallback } from 'react';

// v3: wider defaults so task names and dates aren't truncated out of the box
const STORAGE_KEY = 'trueppm.gantt.columnWidths.v3';

export const MIN_COL_WIDTHS = {
  task: 120,
  durStart: 90,
  progress: 44,
} as const;

export type ColumnKey = keyof typeof MIN_COL_WIDTHS;

const DEFAULTS: Record<ColumnKey, number> = {
  task: 220,
  durStart: 120,
  progress: 50,
};

function load(): Record<ColumnKey, number> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<Record<ColumnKey, number>>;
    return (Object.keys(DEFAULTS) as ColumnKey[]).reduce(
      (acc, k) => {
        const v = parsed[k];
        acc[k] = typeof v === 'number' ? Math.max(v, MIN_COL_WIDTHS[k]) : DEFAULTS[k];
        return acc;
      },
      {} as Record<ColumnKey, number>,
    );
  } catch {
    return { ...DEFAULTS };
  }
}

export interface ColumnWidths {
  widths: Record<ColumnKey, number>;
  setWidth: (col: ColumnKey, width: number) => void;
  totalWidth: number;
}

/**
 * Persist and expose Gantt task-list column widths in localStorage.
 *
 * Widths are clamped to MIN_COL_WIDTHS and stored under STORAGE_KEY (v3).
 * Returns widths, a setWidth callback, and the total width of all columns.
 */
export function useColumnWidths(): ColumnWidths {
  const [widths, setWidths] = useState<Record<ColumnKey, number>>(load);

  const setWidth = useCallback((col: ColumnKey, width: number) => {
    const clamped = Math.max(width, MIN_COL_WIDTHS[col]);
    setWidths((prev) => {
      const next = { ...prev, [col]: clamped };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // quota exceeded or private mode — silently ignore
      }
      return next;
    });
  }, []);

  const totalWidth = widths.task + widths.durStart + widths.progress;

  return { widths, setWidth, totalWidth };
}
