import type { BoardCadence, DeliveryMode, GovernanceClass, Methodology } from '@/types';

/**
 * Methodology-aware defaults for a new task's governance/delivery taxonomy (#2667).
 *
 * `governance_class` and `delivery_mode` used to always default to `'flow'` /
 * `'waterfall'` regardless of the project's own resolved methodology — a
 * self-contradictory dialog on a WATERFALL project (Flow governance describes
 * itself as "agile, sprint- or kanban-governed work" on a project with no
 * sprints or board governance) and a correctness bug on AGILE (delivery mode
 * stuck at waterfall never engages point-burndown rollup or agile-aware Monte
 * Carlo).
 *
 * The server is the source of truth (API-first): the task-create serializer
 * resolves the same default when a client omits the field, so mobile and MCP
 * agree with web. This module mirrors that resolution purely so the dialog can
 * open on the value the server would pick — there is no "preview the default"
 * endpoint to read it back from. Keep in sync with
 * `packages/api/src/trueppm_api/apps/projects/task_classification_defaults.py`.
 */

/**
 * The governance class a new task should default to for a project's preset.
 *
 * `WATERFALL` → `gated` (phase-gate governance matches a project with no
 * sprints or board governance). Every other preset (`AGILE`, `HYBRID`) keeps
 * the existing `flow` default — `HYBRID` deliberately, because it is the
 * preset that mixes both governance overlays and has no single "right" class
 * to steer toward.
 */
export function defaultGovernanceClassFor(methodology: Methodology): GovernanceClass {
  return methodology === 'WATERFALL' ? 'gated' : 'flow';
}

/**
 * The delivery mode a new task should default to for a project's preset.
 *
 * - `WATERFALL` / `HYBRID` → `waterfall` (`HYBRID` keeps today's literal
 *   default — the lossless choice for a preset that mixes delivery modes).
 * - `AGILE` → `scrum`, unless the project's board already runs continuous-flow
 *   Kanban with no sprint cadence (`boardCadence === 'continuous'`, ADR-0164),
 *   in which case → `kanban` — the deliberate flow-without-sprints choice.
 *   `scrum` is the load-bearing default for a brand-new agile project with
 *   nothing configured yet: an unpointed scrum task degrades to identical
 *   rollup behavior as a waterfall one, while kanban would immediately
 *   binarize percent-complete and equal-weight every task (see #2667).
 */
export function defaultDeliveryModeFor(
  methodology: Methodology,
  boardCadence: BoardCadence,
): DeliveryMode {
  if (methodology === 'AGILE') {
    return boardCadence === 'continuous' ? 'kanban' : 'scrum';
  }
  return 'waterfall';
}

/** A methodology-consistent subset of a taxonomy field's values, and the rest. */
export interface TaxonomyGroups<V extends string> {
  /** Values consistent with the project's own preset — shown first. */
  primary: V[];
  /** Every other value — still selectable, just de-emphasized (never removed;
   *  the taxonomy is a documented hybrid seam, ADR-0036). */
  other: V[];
}

/**
 * How to group `governance_class` options for a project's preset, or `null`
 * to render the flat, ungrouped list.
 *
 * `HYBRID` returns `null` — it is the preset that deliberately mixes both
 * governance overlays, so there is no "off-preset" value to de-emphasize.
 */
export function governanceClassGroups(
  methodology: Methodology,
): TaxonomyGroups<GovernanceClass> | null {
  switch (methodology) {
    case 'WATERFALL':
      return { primary: ['gated'], other: ['flow', 'hybrid'] };
    case 'AGILE':
      return { primary: ['flow'], other: ['gated', 'hybrid'] };
    default:
      return null;
  }
}

/**
 * How to group `delivery_mode` options for a project's preset, or `null` to
 * render the flat, ungrouped list.
 *
 * Both `scrum` and `kanban` count as on-preset for `AGILE` — the split between
 * them is a board-cadence choice, not a methodology mismatch. `milestone`
 * always sits in `other`: it is driven by the `is_milestone` toggle rather
 * than chosen directly, and only ever appears on this control when editing an
 * existing milestone task.
 */
export function deliveryModeGroups(
  methodology: Methodology,
): TaxonomyGroups<DeliveryMode> | null {
  switch (methodology) {
    case 'WATERFALL':
      return { primary: ['waterfall'], other: ['scrum', 'kanban', 'milestone'] };
    case 'AGILE':
      return { primary: ['scrum', 'kanban'], other: ['waterfall', 'milestone'] };
    default:
      return null;
  }
}
