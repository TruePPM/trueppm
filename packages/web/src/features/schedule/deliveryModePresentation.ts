import type { DeliveryMode, Task } from '@/types';

/**
 * How a Schedule outline row presents its delivery mode (#2737, ADR-0801).
 *
 * The two hybrid axes are orthogonal and only one of them describes *how work
 * executes*: `delivery_mode`. `governance_class` selects which overlay governs
 * and is deliberately NOT rendered here — a row cannot carry two competing
 * glance signals without one of them being read as the other, and the axis a
 * planner needs to see at a glance is the one the rollup engine keys on.
 *
 * `waterfall` is the baseline and renders nothing. That is not an omission: it
 * is the same convention the canvas has used since #2727 (`drawDeliveryModeMark`
 * returns early on waterfall, and ScheduleLegend carries no waterfall swatch),
 * and matching it is what keeps the outline and the timeline from contradicting
 * each other. A gated plan of 400 rows would otherwise carry 400 identical
 * chips, which is noise, not signal — the shape of a hybrid is legible precisely
 * because the non-default branches are the ones that draw.
 */
export type RowModeKind = 'gated' | 'scrum' | 'kanban' | 'mixed';

/** The single-mode kinds a `mixed` row can be composed of, in canonical order. */
export const SINGLE_MODE_ORDER = ['gated', 'scrum', 'kanban'] as const;
export type SingleModeKind = (typeof SINGLE_MODE_ORDER)[number];

export interface RowMode {
  kind: RowModeKind;
  /**
   * The distinct modes this row resolves from — one entry for a single-mode
   * row, two or three for `mixed`, always in {@link SINGLE_MODE_ORDER}. The
   * gutter is built from this list rather than from `kind`, so a `scrum +
   * kanban` phase is drawn from its actual two hues instead of a generic
   * "something is mixed" wash that would name neither.
   */
  parts: SingleModeKind[];
}

/**
 * The delivery mode a single row contributes to its ancestors' rollup, or
 * `null` when it contributes nothing.
 *
 * Milestones contribute `null`, and that is the load-bearing case. `is_milestone
 * ⟺ delivery_mode = 'milestone' ⟺ duration = 0` is one coupled fact (see
 * `task_classification._classify_row`), so a gate sitting inside an otherwise
 * uniform phase is not evidence that the phase mixes delivery modes — it is a
 * gate. Counting it would mark almost every phase in every plan `MIXED`, which
 * would make the signal useless on exactly the plans it exists for.
 */
function contributedMode(task: Task): SingleModeKind | null {
  if (task.isMilestone) return null;
  const mode: DeliveryMode = task.deliveryMode ?? 'waterfall';
  if (mode === 'milestone') return null;
  if (mode === 'scrum') return 'scrum';
  if (mode === 'kanban') return 'kanban';
  return 'gated';
}

function toRowMode(parts: Set<SingleModeKind>): RowMode {
  const ordered = SINGLE_MODE_ORDER.filter((m) => parts.has(m));
  return {
    kind: ordered.length > 1 ? 'mixed' : (ordered[0] ?? 'gated'),
    parts: ordered.length ? ordered : ['gated'],
  };
}

/**
 * Resolve every task's presented mode, rolling descendants up into parents.
 *
 * A parent reads from **its descendants**, not from its own `delivery_mode`.
 * That is deliberate and matches the design handoff (case 04): after cascading
 * scrum onto phase 4 while 4.1 keeps a gated override, phase 4 reads `MIXED`
 * even though its own field now says scrum. The chip describes the subtree the
 * planner is looking at; the row's own stored value is visible in the drawer
 * and in the classification popover, which is where a single row's field
 * belongs.
 *
 * A parent whose descendants are all milestones (so they contribute nothing)
 * falls back to its own mode rather than to the `gated` default — otherwise a
 * gate-only phase in a scrum branch would silently read as gated.
 *
 * O(n) over the task list: one pass to index children, one post-order walk.
 * Callers memoize on the task array.
 */
export function computeRowModes(tasks: Task[]): Map<string, RowMode> {
  const childIds = new Map<string, string[]>();
  const byId = new Map<string, Task>();
  for (const task of tasks) {
    byId.set(task.id, task);
    if (task.parentId) {
      const siblings = childIds.get(task.parentId);
      if (siblings) siblings.push(task.id);
      else childIds.set(task.parentId, [task.id]);
    }
  }

  const resolved = new Map<string, RowMode>();
  /**
   * What each row hands UP to its ancestors — kept separate from what it
   * DISPLAYS, because a milestone contributes nothing while still displaying
   * as the baseline. Collapsing the two would let one gate inside an otherwise
   * uniform scrum phase read the phase as MIXED, which is the failure this
   * whole rollup exists to avoid.
   */
  const contributed = new Map<string, Set<SingleModeKind>>();

  // Iterative post-order so a 2000-row import can't blow the call stack the way
  // a recursive walk would on a deep WBS.
  const walk = (rootId: string): void => {
    const stack: Array<{ id: string; expanded: boolean }> = [{ id: rootId, expanded: false }];
    while (stack.length) {
      const frame = stack.pop();
      if (!frame) break;
      const kids = childIds.get(frame.id) ?? [];
      if (!frame.expanded && kids.length) {
        stack.push({ id: frame.id, expanded: true });
        for (const kid of kids) stack.push({ id: kid, expanded: false });
        continue;
      }
      const task = byId.get(frame.id);
      if (!task) continue;
      const parts = new Set<SingleModeKind>();
      for (const kid of kids) {
        for (const part of contributed.get(kid) ?? []) parts.add(part);
      }
      // A leaf, or a parent every one of whose descendants is a gate: fall back
      // to this row's own contribution. A gate itself contributes nothing and
      // displays as the baseline, so it renders no chip — its diamond glyph
      // already says what it is.
      if (!parts.size) {
        const own = contributedMode(task);
        if (own) parts.add(own);
      }
      contributed.set(frame.id, parts);
      resolved.set(frame.id, toRowMode(parts));
    }
  };

  for (const task of tasks) {
    if (!task.parentId || !byId.has(task.parentId)) walk(task.id);
  }
  // Orphans whose parent id points outside the loaded set (a filtered or
  // paginated list) never got walked from a root; resolve them standalone
  // rather than leaving the row with no mode at all.
  for (const task of tasks) {
    if (!resolved.has(task.id)) walk(task.id);
  }

  return resolved;
}

export interface ModePresentation {
  /** Chip text. Uppercase — it is a classification token, not prose. */
  label: string;
  /** Sentence naming what the mode means, for the chip's title/aria-label. */
  description: string;
  /** CSS colors for each band of the gutter, top to bottom. */
  colors: string[];
}

/**
 * Per-part color, as a CSS custom property rather than a literal.
 *
 * `--agile` / `--kanban` are the same hues the canvas uses (`COLOR.deliveryScrum`
 * / `COLOR.deliveryKanban` in GanttRenderer.ts) and the same ones ScheduleLegend's
 * swatches already draw, so a row's gutter, its bar texture and the legend entry
 * that explains them cannot drift apart. `--ink-2` carries the gated band: it is
 * the neutral that flips light/dark, which `--navy` (light-only) does not.
 */
const PART_COLOR: Record<SingleModeKind, string> = {
  gated: 'var(--ink-2)',
  scrum: 'var(--agile)',
  kanban: 'var(--kanban)',
};

const SINGLE_DESCRIPTION: Record<SingleModeKind, string> = {
  gated: 'Gated — progress is entered explicitly and dates are governed by the schedule',
  scrum: 'Scrum — progress rolls up from story-point burndown, and velocity feeds Monte Carlo',
  kanban: 'Kanban — progress rolls up from item throughput',
};

/** Human label for one delivery mode value, for popover copy and receipts. */
export const DELIVERY_MODE_LABEL: Record<DeliveryMode, string> = {
  waterfall: 'waterfall',
  scrum: 'scrum',
  kanban: 'kanban',
  milestone: 'milestone',
};

/**
 * Whether a row draws a gutter and a chip at all.
 *
 * See the module docstring: `gated` is the baseline and draws nothing, matching
 * the canvas. Everything else draws both — never color alone, since the chip
 * carries the same fact in text (WCAG 1.4.1).
 */
export function isModeVisible(mode: RowMode | undefined): mode is RowMode {
  return mode !== undefined && mode.kind !== 'gated';
}

export function modePresentation(mode: RowMode): ModePresentation {
  if (mode.kind !== 'mixed') {
    const part = mode.kind;
    return {
      label: part.toUpperCase(),
      description: SINGLE_DESCRIPTION[part],
      colors: [PART_COLOR[part]],
    };
  }
  const names = mode.parts.map((p) => SINGLE_DESCRIPTION[p].split(' —')[0].toLowerCase());
  return {
    label: 'MIXED',
    description: `Mixed subtree — this branch contains ${names.join(' and ')} work. Dependencies still cross the boundary; nothing forks.`,
    colors: mode.parts.map((p) => PART_COLOR[p]),
  };
}

/**
 * The `background` value for a mode gutter: one solid band per contributing
 * mode, split evenly top to bottom.
 *
 * A `mixed` phase is drawn from the hues actually present rather than a fixed
 * two-tone, so `scrum + kanban` and `gated + scrum` are visibly different
 * branches instead of both reading "mixed, somehow".
 */
export function gutterBackground(colors: string[]): string {
  if (colors.length === 1) return colors[0];
  const step = 100 / colors.length;
  const stops = colors.map((c, i) => `${c} ${i * step}% ${(i + 1) * step}%`);
  return `linear-gradient(180deg, ${stops.join(', ')})`;
}

/**
 * The delivery-mode phrase a screen reader hears for a row, or `null` when the
 * row draws nothing (#3040).
 *
 * The canvas is `aria-hidden`, so `ScheduleAriaOverlay` is the ONLY channel by
 * which a bar's mode reaches a screen reader. Before this existed the overlay
 * built its suffix from the row's own `delivery_mode` while the outline chip
 * three inches to the left built its label from the rolled-up subtree, so a
 * `MIXED` phase announced a single mode and the mixed state was carried by a
 * color band and a texture alone — information in a visual channel only
 * (WCAG 1.4.1).
 *
 * `gated` returns `null` on purpose, matching {@link isModeVisible}: the
 * baseline draws no gutter and no chip, so announcing "Waterfall delivery" on
 * every row of a 400-row gated plan would put a suffix in speech that has no
 * counterpart on screen — the same noise the chip convention exists to avoid.
 *
 * Deliberately SHORTER than {@link modePresentation}'s `description`. The chip
 * is read once, on demand; this suffix is read on every bar a user arrows
 * through, so it names the constituents and stops.
 */
export function rowModeSpeech(mode: RowMode): string | null {
  if (mode.kind === 'gated') return null;
  if (mode.kind !== 'mixed') return `${mode.kind === 'scrum' ? 'Scrum' : 'Kanban'} delivery`;
  return `Mixed delivery — this branch contains ${mode.parts.join(' and ')} work`;
}
