import { useState, useCallback, useMemo } from 'react';
import type { Methodology } from '@/types';

// v5: add wbs (#248) and owner (#248) columns
//
// NOT bumped for the `links` column (#3023). Both loaders below already fall
// back to the default for a key the stored payload does not carry, so a v5
// payload written before `links` existed reads back as "links at its default,
// every other column at the width you set". Bumping the key would have thrown
// away every user's persisted widths to add one column — a reset nobody asked
// for, to fix a migration that does not need fixing.
const WIDTHS_KEY = 'trueppm.schedule.columnWidths.v5';
// v1: per-column visibility (task is always locked visible)
const VISIBILITY_KEY = 'trueppm.schedule.columnVisibility.v1';

/**
 * Key order here is the Display menu's Columns order (`surfaceToggleableColumns`
 * filters `Object.keys`), so it is kept in the same order the header and the row
 * draw: WBS · Task · Links · Dur · Start · Finish · % · Owner.
 */
export const MIN_COL_WIDTHS = {
  wbs: 40,
  task: 120,
  // One flag (`←Mixed×4`, the widest the token can get) fits at 52 with its
  // padding; a row showing BOTH directions truncates below the 104 default, and
  // the chips carry `truncate` so it reads as clipped rather than as a shorter,
  // wrong shape (#3023).
  links: 52,
  dur: 40,
  start: 60,
  finish: 60,
  progress: 56,  // "33.33%" needs ~52px; floor at 56 to avoid overflow
  owner: 40,
  // Float floors fit the widest value the CPM can produce at this text size
  // ("-999d" is 5 mono glyphs ~ 33px) plus the cell's own `pr-2` (8px). 48 is
  // that with a little slack; below it the minus sign clips off the left and a
  // late task reads as an early one (#3344).
  totalFloat: 48,
  freeFloat: 48,
} as const;

export type ColumnKey = keyof typeof MIN_COL_WIDTHS;

const DEFAULTS: Record<ColumnKey, number> = {
  wbs: 48,
  task: 220,
  links: 104,
  dur: 52,
  start: 74,
  finish: 74,
  progress: 60,
  owner: 72,
  // 56 each, and the number is measured rather than chosen (#3344). At 1280 with
  // the sidebar expanded the outline pane starts at x=248, so the room the clamp
  // has to give the outline is 1280 − 248 − MIN_BAR_TRACK(320) − SPLITTER(4) =
  // 708px, and the eight-column outline already needed 738 (704 + a 34px left
  // reserve). **Owner was therefore already clipped by 30px before these two
  // columns existed** — a pre-existing overflow, which is a finding rather than a
  // baseline (web rule 366(d)) and is filed separately; it is not something this
  // change can fix from the column widths.
  //
  // What the width does decide is the FIRST viewport at which the full set fits.
  // At 64px each the sum is 866 against 1440's 868px budget — two pixels, which
  // the next column erases. At 56 it is 850, leaving 18px, and 56 still holds the
  // widest value CPM can produce ("-999d", ~33px) plus the cell's `pr-2`.
  totalFloat: 56,
  freeFloat: 56,
};

/**
 * Which columns a project sees when the user has expressed no opinion.
 *
 * Everything except the two float columns is unconditionally on, as it has been
 * since the set existed. Float is the one column pair whose usefulness is a
 * property of the METHODOLOGY rather than of the person: total and free float
 * are the numbers a waterfall or hybrid planner scans a plan by, and they are
 * noise on an AGILE board-driven project whose Schedule tab is not even in the
 * nav by default (`methodologyTabs.ts`, #2619). So they default off there and on
 * everywhere else (#3344).
 *
 * This is a DEFAULT, not a narrowing: a user on an AGILE project can still turn
 * them on from Display ▸ Columns, and that choice is then explicit and sticks.
 * The distinction is why `useColumnWidths` persists only explicit choices — see
 * {@link loadExplicitVisibility}.
 */
export function defaultVisibilityFor(
  methodology: Methodology | null | undefined,
): Record<ColumnKey, boolean> {
  const floatByDefault = methodology !== 'AGILE';
  return {
    wbs: true,
    task: true,
    links: true,
    dur: true,
    start: true,
    finish: true,
    progress: true,
    owner: true,
    totalFloat: floatByDefault,
    freeFloat: floatByDefault,
  };
}

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

/**
 * Read back only the columns the user has ACTUALLY toggled.
 *
 * This used to return a full record with the defaults already folded in, which
 * cannot express "no opinion" — and without that state a methodology-dependent
 * default is impossible, because a stored `false` and an unset key look
 * identical. Keeping the stored payload sparse is also what makes the default
 * re-derive when `effective_methodology` arrives from its query a beat after
 * first paint, instead of latching whatever was true at mount.
 *
 * No storage-key bump: a payload written before this change is a full record of
 * booleans, which reads back as "every one of those columns is an explicit
 * choice" — byte-identical behaviour to what that user had — while the two float
 * keys it cannot contain fall through to the methodology default. Same reasoning
 * as the `links` column (#3023): bumping would discard everyone's layout to add
 * a column.
 */
function loadExplicitVisibility(): Partial<Record<ColumnKey, boolean>> {
  try {
    const raw = localStorage.getItem(VISIBILITY_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<Record<ColumnKey, boolean>>;
    // Read key by key rather than trusting the blob: a hand-edited or
    // older-shaped value must not put a non-boolean into the record and make
    // `checked` render as undefined.
    const out: Partial<Record<ColumnKey, boolean>> = {};
    for (const k of Object.keys(MIN_COL_WIDTHS) as ColumnKey[]) {
      if (typeof parsed[k] === 'boolean') out[k] = parsed[k];
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Fold the user's explicit choices over the methodology default. `task` is
 * always visible and cannot be turned off.
 */
export function resolveVisibility(
  explicit: Partial<Record<ColumnKey, boolean>>,
  methodology: Methodology | null | undefined,
): Record<ColumnKey, boolean> {
  const defaults = defaultVisibilityFor(methodology);
  return (Object.keys(defaults) as ColumnKey[]).reduce(
    (acc, k) => {
      acc[k] = k === 'task' ? true : (explicit[k] ?? defaults[k]);
      return acc;
    },
    {} as Record<ColumnKey, boolean>,
  );
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
 * Widths are clamped to MIN_COL_WIDTHS (WIDTHS_KEY v5).
 * Visibility is stored separately (VISIBILITY_KEY v1) as the user's EXPLICIT
 * choices only; the returned `visible` record folds those over
 * {@link defaultVisibilityFor}, so a column the user has never touched follows
 * the project's methodology. The task column is always visible.
 * totalWidth sums only the visible columns.
 *
 * @param methodology the project's SERVER-RESOLVED `effective_methodology`
 *   (web rule 196 — never the raw `methodology` field). `null`/`undefined` while
 *   the project query is in flight is safe: `visible` is derived on every render
 *   rather than seeded into state, so the correct default appears as soon as the
 *   value lands, with no stale latch (#3344).
 */
export function useColumnWidths(methodology?: Methodology | null): ColumnWidths {
  const [widths, setWidths] = useState<Record<ColumnKey, number>>(loadWidths);
  const [explicitVisible, setExplicitVisible] =
    useState<Partial<Record<ColumnKey, boolean>>>(loadExplicitVisibility);
  const visible = useMemo(
    () => resolveVisibility(explicitVisible, methodology),
    [explicitVisible, methodology],
  );

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

  const toggleColumn = useCallback(
    (col: ColumnKey) => {
      if (col === 'task') return; // task column is always visible
      // Toggle against the RESOLVED value, not the sparse one: a column showing
      // by default has no stored entry, so `!prev[col]` on an absent key would
      // read `!undefined` and "turn it on" while it is already on.
      const next = { ...explicitVisible, [col]: !visible[col] };
      setExplicitVisible(next);
      try {
        localStorage.setItem(VISIBILITY_KEY, JSON.stringify(next));
      } catch {
        // quota exceeded or private mode — silently ignore
      }
    },
    [explicitVisible, visible],
  );

  const totalWidth = (Object.keys(widths) as ColumnKey[]).reduce(
    (sum, k) => sum + (visible[k] ? widths[k] : 0),
    0,
  );

  return { widths, visible, setWidth, toggleColumn, totalWidth };
}
