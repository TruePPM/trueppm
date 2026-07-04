/**
 * useBoardResize — persisted board column widths and phase-lane heights (#285).
 *
 * The board's Visiban parity gap: a user can drag the right edge of a column
 * header to widen a column, and the bottom edge of a phase lane to make a phase
 * taller. Both preferences are per-browser (localStorage), keyed independently:
 *
 *   - column widths  → keyed by TaskStatus  → `trueppm.board.columnWidths.v1`
 *   - phase heights  → keyed by phase id     → `trueppm.board.phaseHeights.v1`
 *
 * A stored column width overrides the zoom-driven `--board-col-w` track default
 * for that one column; unset columns fall back to the zoom default. Heights are
 * applied as a `min-height` on the lane so the lane grows but never shrinks a
 * card below its own minimum.
 *
 * Both hooks clamp on write and on read (a hand-edited or stale localStorage
 * value can never drop a column below MIN_BOARD_COLUMN_WIDTH or a phase below
 * MIN_BOARD_PHASE_HEIGHT). Cross-tab edits sync via the StorageEvent, mirroring
 * useScheduleLegendCollapsed.
 */
import { useCallback, useEffect, useState } from 'react';

/** Minimum column width (px). Below this a card's content clips (#285). */
export const MIN_BOARD_COLUMN_WIDTH = 200;
/** Minimum phase-lane height (px) — enough to show two stacked cards (#285). */
export const MIN_BOARD_PHASE_HEIGHT = 120;

const COLUMN_WIDTHS_KEY = 'trueppm.board.columnWidths.v1';
const PHASE_HEIGHTS_KEY = 'trueppm.board.phaseHeights.v1';

/** Clamp a proposed column width to the floor, rounded to a whole pixel. */
export function clampBoardColumnWidth(px: number): number {
  return Math.max(Math.round(px), MIN_BOARD_COLUMN_WIDTH);
}

/** Clamp a proposed phase height to the floor, rounded to a whole pixel. */
export function clampBoardPhaseHeight(px: number): number {
  return Math.max(Math.round(px), MIN_BOARD_PHASE_HEIGHT);
}

type SizeMap = Record<string, number>;

/**
 * Read a `{ key: px }` map from localStorage, dropping any non-finite entry and
 * clamping every value with `clamp`. Returns an empty map on any parse failure
 * or when localStorage is unavailable (private mode).
 */
function loadSizeMap(storageKey: string, clamp: (px: number) => number): SizeMap {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: SizeMap = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'number' && Number.isFinite(v)) {
        out[k] = clamp(v);
      }
    }
    return out;
  } catch {
    return {};
  }
}

function persist(storageKey: string, map: SizeMap): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(map));
  } catch {
    // quota exceeded or private mode — degrade to in-memory state
  }
}

interface SizeMapHook {
  sizes: SizeMap;
  setSize: (key: string, px: number) => void;
}

function useSizeMap(storageKey: string, clamp: (px: number) => number): SizeMapHook {
  const [sizes, setSizes] = useState<SizeMap>(() => loadSizeMap(storageKey, clamp));

  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === storageKey) setSizes(loadSizeMap(storageKey, clamp));
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [storageKey, clamp]);

  const setSize = useCallback(
    (key: string, px: number) => {
      setSizes((prev) => {
        const next = { ...prev, [key]: clamp(px) };
        persist(storageKey, next);
        return next;
      });
    },
    [storageKey, clamp],
  );

  return { sizes, setSize };
}

export interface BoardColumnWidths {
  /** Explicit widths keyed by TaskStatus. Absent keys use the zoom default. */
  widths: SizeMap;
  /** Persist a clamped width for one column. */
  setWidth: (status: string, px: number) => void;
}

/** Persist and expose per-column board widths (#285). */
export function useBoardColumnWidths(): BoardColumnWidths {
  const { sizes, setSize } = useSizeMap(COLUMN_WIDTHS_KEY, clampBoardColumnWidth);
  return { widths: sizes, setWidth: setSize };
}

export interface BoardPhaseHeights {
  /** Explicit heights keyed by phase id. Absent keys use the natural height. */
  heights: SizeMap;
  /** Persist a clamped height for one phase lane. */
  setHeight: (phaseId: string, px: number) => void;
}

/** Persist and expose per-phase board lane heights (#285). */
export function useBoardPhaseHeights(): BoardPhaseHeights {
  const { sizes, setSize } = useSizeMap(PHASE_HEIGHTS_KEY, clampBoardPhaseHeight);
  return { heights: sizes, setHeight: setSize };
}
