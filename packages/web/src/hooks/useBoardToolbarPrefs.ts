/**
 * useBoardToolbarPrefs — calm-toolbar preferences (issue 382, epic 361 child B).
 *
 * Persists two surfaces that the calm toolbar owns:
 *   - layout: rail | drawer | queue (gates which sibling backlog layout renders)
 *   - backlogDensity: compact | comfortable | full (passed to BacklogBand)
 *
 * Sibling MRs (issue 383 drawer, issue 384 queue) wire up the alternate layouts; until
 * they land the layout selection persists but rail is the only renderable
 * variant. Density preference is independent of board card density (which
 * lives in useBoardDensity, BoardView.tsx) — this is the BACKLOG card density.
 */
import { useCallback, useEffect, useState } from 'react';

export type BoardLayoutVariant = 'rail' | 'drawer' | 'queue';
export type BacklogDensity = 'compact' | 'comfortable' | 'full';
/**
 * Board-local zoom level (issue 379, ADR-0145). An independent axis from board-card
 * Density: zoom scales board *chrome spacing* (phase-column width, inter-column
 * gap, inter-card gap) so more — or less — of the board fits on screen, while
 * Density scales per-card padding. Realized as CSS custom properties, not a
 * transform/zoom (which would break dnd-kit drag math).
 */
export type BoardZoom = 'small' | 'normal' | 'large';
/**
 * Board swimlane grouping mode (issue 324; `epic` added in issue 364). Persisted
 * per-user-per-device like zoom/density (not a saved-view config) — it's a
 * personal lens on the board, not shared board state. `assignee` groups cards by
 * primary assignee; `epic` groups by the card's parent epic (a read-only lens —
 * the epic FK is edited from the card drawer, not by dragging between lanes).
 * Team grouping is a deferred follow-up (needs a server-side team field).
 */
export type BoardGroupMode = 'phase' | 'assignee' | 'epic';

export interface BoardToolbarPrefs {
  layout: BoardLayoutVariant;
  backlogDensity: BacklogDensity;
  zoom: BoardZoom;
  groupBy: BoardGroupMode;
}

const STORAGE_KEY = 'trueppm.board.toolbarPrefs.v1';
const DEFAULTS: BoardToolbarPrefs = {
  layout: 'rail',
  backlogDensity: 'comfortable',
  zoom: 'normal',
  groupBy: 'phase',
};

function read(): BoardToolbarPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<BoardToolbarPrefs>;
    return {
      layout: parsed.layout === 'drawer' || parsed.layout === 'queue' ? parsed.layout : 'rail',
      backlogDensity:
        parsed.backlogDensity === 'compact' || parsed.backlogDensity === 'full'
          ? parsed.backlogDensity
          : 'comfortable',
      // Additive (issue 379): a stored v1 blob without `zoom` defaults to 'normal',
      // so the key change is backwards-compatible without a version bump.
      zoom: parsed.zoom === 'small' || parsed.zoom === 'large' ? parsed.zoom : 'normal',
      // Additive (issue 324, 364): a stored blob without `groupBy` defaults to
      // 'phase' — same backwards-compatible pattern as zoom, no version bump. An
      // unrecognized value also falls back to 'phase'.
      groupBy:
        parsed.groupBy === 'assignee' || parsed.groupBy === 'epic' ? parsed.groupBy : 'phase',
    };
  } catch {
    return DEFAULTS;
  }
}

function write(prefs: BoardToolbarPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* localStorage unavailable — non-fatal, prefs revert to defaults next mount */
  }
}

export function useBoardToolbarPrefs(): {
  layout: BoardLayoutVariant;
  backlogDensity: BacklogDensity;
  zoom: BoardZoom;
  groupBy: BoardGroupMode;
  setLayout: (v: BoardLayoutVariant) => void;
  setBacklogDensity: (d: BacklogDensity) => void;
  setZoom: (z: BoardZoom) => void;
  setGroupBy: (g: BoardGroupMode) => void;
} {
  const [prefs, setPrefs] = useState<BoardToolbarPrefs>(() => read());

  // Cross-tab sync: if another tab updates the prefs, mirror the change here.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY) setPrefs(read());
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setLayout = useCallback((layout: BoardLayoutVariant) => {
    setPrefs((p) => {
      const next = { ...p, layout };
      write(next);
      return next;
    });
  }, []);

  const setBacklogDensity = useCallback((backlogDensity: BacklogDensity) => {
    setPrefs((p) => {
      const next = { ...p, backlogDensity };
      write(next);
      return next;
    });
  }, []);

  const setZoom = useCallback((zoom: BoardZoom) => {
    setPrefs((p) => {
      const next = { ...p, zoom };
      write(next);
      return next;
    });
  }, []);

  const setGroupBy = useCallback((groupBy: BoardGroupMode) => {
    setPrefs((p) => {
      const next = { ...p, groupBy };
      write(next);
      return next;
    });
  }, []);

  return {
    layout: prefs.layout,
    backlogDensity: prefs.backlogDensity,
    zoom: prefs.zoom,
    groupBy: prefs.groupBy,
    setLayout,
    setBacklogDensity,
    setZoom,
    setGroupBy,
  };
}
