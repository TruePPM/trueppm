/**
 * The shell v2 Schedule toolbar's concession ladder (#4796, rule 343).
 *
 * Pass 2 cuts the v1 toolbar's eleven equal-weight controls to three tiers:
 *
 * - **Primary** — Filter, Zoom, Add task. Never fold. Zoom may *collapse* to a
 *   select-style trigger that still shows the current tier, and Add task may
 *   collapse to an icon button that keeps its accessible name, but neither
 *   ever leaves the bar.
 * - **Inline** — Today, Baseline, Critical-only. In the bar at 1440, demoted
 *   into the overflow as the bar narrows.
 * - **Overflow** — Group, Columns, Expand all, Dependency links (the design's "Link mode": it shows or hides the arrows, so it is named for what it does), Export. Always in
 *   the labeled overflow; the overflow's accessible name carries the count.
 *
 * The legend is information, not a control (rule 343 (e): a readout may only
 * shorten, never hide), so its only rung *relocates* it into the timeline
 * header; it never reaches the overflow.
 *
 * **Order.** The design's ladder reads "1024 folds Critical-only then Baseline;
 * 768 folds Today and Zoom becomes a select; 390 makes Add task an icon". Rule
 * 343 (d) is binding over a design's interleaving: every collapse is spent
 * before any demotion, because a collapse costs a glance and a demotion costs a
 * hunt. So Zoom collapses and the legend relocates first, then the three inline
 * commands demote in the design's relative order, and Add task — tier A —
 * collapses last (rule 343 (e): tier A concedes last or never). The widths the
 * design names are where its own strings landed; the loop measures, so the
 * real thresholds move with the project's strings, the rail and edit rights.
 */

export type Placement = 'bar' | 'overflow';

/** Where every width-sensitive part of the v2 toolbar stands right now. */
export interface ScheduleV2Composition {
  /** `segmented`: −/tier/+/Fit inline; `select`: one `Month ▾` trigger. */
  zoom: 'segmented' | 'select';
  /** Toolbar row, or relocated into the timeline header. Never hidden. */
  legend: 'bar' | 'timeline-header';
  criticalOnly: Placement;
  baseline: Placement;
  today: Placement;
  /** `labeled`: "+ Add task"; `icon`: a `+` button named "Add task". */
  addTask: 'labeled' | 'icon';
}

export interface ScheduleV2Rung {
  id: string;
  /** `collapse` keeps the control in the bar; `demote` moves it to the overflow. */
  kind: 'collapse' | 'demote';
  /** Seed saving in px; the fit loop replaces it with the observed one. */
  estimate: number;
  apply: (draft: ScheduleV2Composition) => void;
}

export const SCHEDULE_V2_BASE: Readonly<ScheduleV2Composition> = {
  zoom: 'segmented',
  legend: 'bar',
  criticalOnly: 'bar',
  baseline: 'bar',
  today: 'bar',
  addTask: 'labeled',
};

export const SCHEDULE_V2_LADDER: readonly ScheduleV2Rung[] = [
  // --- Collapses: nothing leaves the bar. -------------------------------
  {
    id: 'zoom-select',
    kind: 'collapse',
    estimate: 96,
    apply: (c) => {
      c.zoom = 'select';
    },
  },
  {
    id: 'legend-header',
    kind: 'collapse',
    estimate: 300,
    apply: (c) => {
      c.legend = 'timeline-header';
    },
  },
  // --- Demotions, in the design's relative order. -----------------------
  {
    id: 'critical-only',
    kind: 'demote',
    estimate: 104,
    apply: (c) => {
      c.criticalOnly = 'overflow';
    },
  },
  {
    id: 'baseline',
    kind: 'demote',
    estimate: 84,
    apply: (c) => {
      c.baseline = 'overflow';
    },
  },
  {
    id: 'today',
    kind: 'demote',
    estimate: 60,
    apply: (c) => {
      c.today = 'overflow';
    },
  },
  // --- Tier A concedes last, and only collapses. ------------------------
  {
    id: 'add-task-icon',
    kind: 'collapse',
    estimate: 64,
    apply: (c) => {
      c.addTask = 'icon';
    },
  },
];

export const SCHEDULE_V2_MAX_STEP = SCHEDULE_V2_LADDER.length;

/** The composition after the first `step` rungs have been spent. */
export function resolveV2Composition(step: number): ScheduleV2Composition {
  const draft: ScheduleV2Composition = { ...SCHEDULE_V2_BASE };
  const n = Math.max(0, Math.min(step, SCHEDULE_V2_LADDER.length));
  for (let i = 0; i < n; i++) SCHEDULE_V2_LADDER[i].apply(draft);
  return draft;
}

/** The commands that live in the overflow at every width. */
export const ALWAYS_OVERFLOW = ['group', 'columns', 'expandAll', 'linkMode', 'export'] as const;
export type OverflowCommand = (typeof ALWAYS_OVERFLOW)[number];
export type DemotableCommand = 'criticalOnly' | 'baseline' | 'today';

/**
 * Inline commands currently demoted, in bar order. `baselineAvailable` is false
 * when the project has no active baseline: a Baseline toggle with nothing to
 * draw is a control that lies, so it is in neither the bar nor the overflow.
 */
export function demotedCommands(
  c: ScheduleV2Composition,
  baselineAvailable: boolean,
): DemotableCommand[] {
  const out: DemotableCommand[] = [];
  if (c.today === 'overflow') out.push('today');
  if (baselineAvailable && c.baseline === 'overflow') out.push('baseline');
  if (c.criticalOnly === 'overflow') out.push('criticalOnly');
  return out;
}

/**
 * How many commands the overflow menu holds right now — counted from what it
 * renders, never from `ALWAYS_OVERFLOW`'s length. Group is offered only with
 * edit rights, and Columns and Export only when they have a row to show, so a
 * fixed count would name items a reader cannot find. Expand all and
 * Dependency links are always present.
 */
export function overflowCommandCount(present: {
  group: boolean;
  columns: boolean;
  exportItems: boolean;
  demoted: number;
}): number {
  return (
    (present.group ? 1 : 0) +
    (present.columns ? 1 : 0) +
    2 +
    (present.exportItems ? 1 : 0) +
    present.demoted
  );
}

/** The overflow trigger's accessible name — it carries the count (#4796). */
export function overflowLabel(count: number): string {
  return `More schedule actions, ${count} ${count === 1 ? 'item' : 'items'}`;
}
