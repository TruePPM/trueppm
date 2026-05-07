import { useState, useCallback } from 'react';

// v5: add wbs (#248) and owner (#248) columns
const WIDTHS_KEY = 'trueppm.schedule.columnWidths.v5';
// v1: per-column visibility (task is always locked visible)
const VISIBILITY_KEY = 'trueppm.schedule.columnVisibility.v1';

export const MIN_COL_WIDTHS = {
  wbs: 40,
  task: 120,
  dur: 40,
  start: 60,
  finish: 60,
  progress: 40,
  owner: 40,
} as const;

export type ColumnKey = keyof typeof MIN_COL_WIDTHS;

const DEFAULTS: Record<ColumnKey, number> = {
  wbs: 48,
  task: 220,
  dur: 52,
  start: 74,
  finish: 74,
  progress: 44,
  owner: 72,
};

const DEFAULT_VISIBILITY: Record<ColumnKey, boolean> = {
  wbs: true,
  task: true,
  dur: true,
  start: true,
  finish: true,
  progress: true,
  owner: true,
};

function loadWidths(): Record<ColumnKey, number> {
  try {
    const raw = localStorage.getItem(WIDTHS_KEY);
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

function loadVisibility(): Record<ColumnKey, boolean> {
  try {
    const raw = localStorage.getItem(VISIBILITY_KEY);
    if (!raw) return { ...DEFAULT_VISIBILITY };
    const parsed = JSON.parse(raw) as Partial<Record<ColumnKey, boolean>>;
    return (Object.keys(DEFAULT_VISIBILITY) as ColumnKey[]).reduce(
      (acc, k) => {
        acc[k] = k === 'task' ? true : (parsed[k] ?? DEFAULT_VISIBILITY[k]);
        return acc;
      },
      {} as Record<ColumnKey, boolean>,
    );
  } catch {
    return { ...DEFAULT_VISIBILITY };
  }
}

export interface ColumnWidths {
  widths: Record<ColumnKey, number>;
  visible: Record<ColumnKey, boolean>;
  setWidth: (col: ColumnKey, width: number) => void;
  toggleColumn: (col: ColumnKey) => void;
  totalWidth: number;
}

/**
 * Persist and expose Gantt task-list column widths and visibility in localStorage.
 *
 * Widths are clamped to MIN_COL_WIDTHS (WIDTHS_KEY v4).
 * Visibility is stored separately (VISIBILITY_KEY v1); the task column is always visible.
 * totalWidth sums only the visible columns.
 */
export function useColumnWidths(): ColumnWidths {
  const [widths, setWidths] = useState<Record<ColumnKey, number>>(loadWidths);
  const [visible, setVisible] = useState<Record<ColumnKey, boolean>>(loadVisibility);

  const setWidth = useCallback((col: ColumnKey, width: number) => {
    const clamped = Math.max(width, MIN_COL_WIDTHS[col]);
    setWidths((prev) => {
      const next = { ...prev, [col]: clamped };
      try {
        localStorage.setItem(WIDTHS_KEY, JSON.stringify(next));
      } catch {
        // quota exceeded or private mode — silently ignore
      }
      return next;
    });
  }, []);

  const toggleColumn = useCallback((col: ColumnKey) => {
    if (col === 'task') return; // task column is always visible
    setVisible((prev) => {
      const next = { ...prev, [col]: !prev[col] };
      try {
        localStorage.setItem(VISIBILITY_KEY, JSON.stringify(next));
      } catch {
        // silently ignore
      }
      return next;
    });
  }, []);

  const totalWidth = (Object.keys(widths) as ColumnKey[]).reduce(
    (sum, k) => sum + (visible[k] ? widths[k] : 0),
    0,
  );

  return { widths, visible, setWidth, toggleColumn, totalWidth };
}
