import { useState, useCallback } from 'react';

const STORAGE_KEY = 'trueppm.gantt.columnWidths.v1';

export const MIN_COL_WIDTHS = {
  task: 120,
  duration: 48,
  start: 60,
  progress: 48,
} as const;

export type ColumnKey = keyof typeof MIN_COL_WIDTHS;

const DEFAULTS: Record<ColumnKey, number> = {
  task: 180,
  duration: 60,
  start: 72,
  progress: 52,
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

  const totalWidth =
    widths.task + widths.duration + widths.start + widths.progress;

  return { widths, setWidth, totalWidth };
}
