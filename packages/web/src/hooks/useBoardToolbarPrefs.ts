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
  /**
   * Per-cell card cap (issue 1967, ADR-0420). `null` = off (unbounded stacks,
   * the default). A positive integer caps the calm cards shown per phase×status
   * matrix cell and collapses the overflow behind a "+N more" disclosure — a
   * personal density lens, not shared board state, like zoom/groupBy.
   */
  cellCap: number | null;
}

/** Desktop fallback layout when the user has never explicitly chosen one. */
const DEFAULT_LAYOUT: BoardLayoutVariant = 'rail';

/**
 * Internal persisted shape. `layout` is nullable — `null` means the user has
 * *never explicitly chosen* a layout, which is distinct from an explicit
 * `'rail'`. The board relies on this distinction to auto-default the layout to
 * Queue on a phone (issue 605) without silently overriding a real choice; a
 * density / zoom / groupBy change must therefore never persist a layout it was
 * given for free (see `write`).
 */
interface StoredPrefs {
  layout: BoardLayoutVariant | null;
  backlogDensity: BacklogDensity;
  zoom: BoardZoom;
  groupBy: BoardGroupMode;
  cellCap: number | null;
}

const STORAGE_KEY = 'trueppm.board.toolbarPrefs.v1';
const DEFAULTS: StoredPrefs = {
  layout: null,
  backlogDensity: 'comfortable',
  zoom: 'normal',
  groupBy: 'phase',
  cellCap: null,
};

/**
 * Resolve the layout the board should actually render.
 *
 * On a phone (`isMobile`) the desktop phase-grid layouts (rail / drawer) are
 * unusable, so when the user has never explicitly chosen a layout we auto-pick
 * the mobile-friendly Queue (issue 605). An explicit choice — including an
 * explicit rail / drawer set on desktop — is always honored, so we never
 * silently flip a user who picked their layout on purpose across the breakpoint.
 */
export function resolveBoardLayout(
  storedLayout: BoardLayoutVariant,
  layoutExplicit: boolean,
  isMobile: boolean,
): BoardLayoutVariant {
  if (isMobile && !layoutExplicit) return 'queue';
  return storedLayout;
}

function read(): StoredPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<BoardToolbarPrefs>;
    return {
      // Stays `null` unless a valid explicit choice was persisted — this is what
      // lets the board auto-default it on mobile (issue 605) without clobbering a
      // real preference. `'rail'` here means the user explicitly picked rail.
      layout:
        parsed.layout === 'rail' || parsed.layout === 'drawer' || parsed.layout === 'queue'
          ? parsed.layout
          : null,
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
      // Additive (issue 1967): a stored blob without `cellCap` defaults to null
      // (off) — same backwards-compatible pattern as zoom/groupBy, no version
      // bump. Only a positive integer is honored; anything else coerces to off.
      cellCap:
        typeof parsed.cellCap === 'number' && Number.isFinite(parsed.cellCap) && parsed.cellCap > 0
          ? Math.floor(parsed.cellCap)
          : null,
    };
  } catch {
    return DEFAULTS;
  }
}

function write(prefs: StoredPrefs): void {
  try {
    // Omit a `null` layout (JSON.stringify drops `undefined` keys) so a blob
    // written by a density / zoom / groupBy change never masquerades as an
    // explicit layout choice on the next read (issue 605).
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...prefs, layout: prefs.layout ?? undefined }),
    );
  } catch {
    /* localStorage unavailable — non-fatal, prefs revert to defaults next mount */
  }
}

export function useBoardToolbarPrefs(): {
  layout: BoardLayoutVariant;
  /** True once the user has explicitly chosen a layout (issue 605). */
  layoutExplicit: boolean;
  backlogDensity: BacklogDensity;
  zoom: BoardZoom;
  groupBy: BoardGroupMode;
  cellCap: number | null;
  setLayout: (v: BoardLayoutVariant) => void;
  setBacklogDensity: (d: BacklogDensity) => void;
  setZoom: (z: BoardZoom) => void;
  setGroupBy: (g: BoardGroupMode) => void;
  setCellCap: (c: number | null) => void;
} {
  const [prefs, setPrefs] = useState<StoredPrefs>(() => read());

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

  const setCellCap = useCallback((cellCap: number | null) => {
    setPrefs((p) => {
      const next = { ...p, cellCap };
      write(next);
      return next;
    });
  }, []);

  return {
    // Effective layout for callers that don't care about mobile auto-defaulting
    // — the desktop fallback. Callers that need the mobile-aware layout combine
    // `layout` + `layoutExplicit` via `resolveBoardLayout`.
    layout: prefs.layout ?? DEFAULT_LAYOUT,
    layoutExplicit: prefs.layout !== null,
    backlogDensity: prefs.backlogDensity,
    zoom: prefs.zoom,
    groupBy: prefs.groupBy,
    cellCap: prefs.cellCap,
    setLayout,
    setBacklogDensity,
    setZoom,
    setGroupBy,
    setCellCap,
  };
}
