import type { DeliveryMode, GovernanceClass, Task } from '@/types';

/**
 * Client-side preview of what `PATCH /projects/{id}/tasks/classification/`
 * will do (#2736, ADR-0801).
 *
 * **This mirrors `task_classification._classify_row` and must be kept in sync
 * with it.** The endpoint has no dry-run mode, and the popover's whole claim is
 * that it "names exactly what changes before it happens" — a footer that guessed
 * would be worse than no footer, because a planner would stop checking it.
 *
 * The mirror is a prediction, never a source of truth. The server's own report
 * comes back on apply and is what the receipt renders, so a drift between the
 * two shows up as a receipt that disagrees with the preview rather than as a
 * silently wrong write. The same precedent (and the same obligation) applies to
 * `lib/taskClassificationDefaults.ts`, which mirrors the server's create-time
 * defaults for the task dialog.
 *
 * Legacy payloads omit these fields; the fallbacks below are the model defaults
 * (`Task.governance_class = flow`, `delivery_mode = waterfall`,
 * `parent_governance_inherited = True`), so an absent field predicts the same
 * comparison the server will make against the stored row.
 */
export interface ClassificationSpec {
  /** Root of the subtree. The server resolves descendants from `wbs_path`. */
  subtreeId: string;
  /** False classifies the root alone. */
  cascade: boolean;
  governanceClass: GovernanceClass | null;
  deliveryMode: DeliveryMode | null;
  /** Explicit per-task governance survives the cascade. Defaults true. */
  preserveGovernanceOverrides: boolean;
  /** Governs the GOVERNANCE axis on milestone rows only. */
  skipMilestones: boolean;
}

export interface AxisPreview {
  applied: number;
  unchanged: number;
  /**
   * `null` on an axis with no inherit bit — **not** `0`. Zero asserts "there
   * were none", a claim about the data; null states the count is not computable
   * on this axis, a claim about the model, and it is the true one. Only
   * `governance_class` carries `parent_governance_inherited`.
   */
  overridesKept: number | null;
}

export interface ClassificationPreviewResult {
  /** Rows the cascade resolves — the root plus, when cascading, its descendants. */
  matched: number;
  /** Rows where at least one field would actually be written. */
  tasksChanged: number;
  /** Rows left unclassified on at least one axis because they are milestones. */
  milestonesSkipped: number;
  governance: AxisPreview | null;
  deliveryMode: AxisPreview | null;
}

const DEFAULT_GOVERNANCE: GovernanceClass = 'flow';
const DEFAULT_DELIVERY: DeliveryMode = 'waterfall';

/**
 * The subtree root plus, when cascading, every descendant — resolved through
 * `parentId` rather than `wbs_path`.
 *
 * The server walks `wbs_path` prefixes; both name the same set, and `parentId`
 * is the edge the client actually holds. A row whose parent is outside the
 * loaded list simply never joins the walk, which under-counts rather than
 * over-counts — the safe direction for a preview, and one the server's own
 * report corrects on apply.
 *
 * Returned in the order the walk reaches them, root first.
 */
export function resolveSubtree(tasks: Task[], subtreeId: string, cascade: boolean): Task[] {
  const root = tasks.find((t) => t.id === subtreeId);
  if (!root) return [];
  if (!cascade) return [root];

  const childIds = new Map<string, Task[]>();
  for (const task of tasks) {
    if (!task.parentId) continue;
    const siblings = childIds.get(task.parentId);
    if (siblings) siblings.push(task);
    else childIds.set(task.parentId, [task]);
  }

  const out: Task[] = [];
  const queue: Task[] = [root];
  const seen = new Set<string>();
  while (queue.length) {
    const task = queue.shift();
    if (!task || seen.has(task.id)) continue;
    seen.add(task.id);
    out.push(task);
    for (const child of childIds.get(task.id) ?? []) queue.push(child);
  }
  return out;
}

interface AxisTally {
  applied: number;
  unchanged: number;
  overridesKept: number;
}

/**
 * Predict one row's outcome. Returns true when any field would be written.
 *
 * Structurally parallel to `_classify_row` on the server, including the two
 * asymmetries that are easy to get backwards:
 *
 * 1. The **root** is the declaration point, so it takes
 *    `parent_governance_inherited = false` while cascaded descendants take
 *    `true`. Declaring a subtree's governance *is* breaking inheritance from
 *    whatever sits above it.
 * 2. `skip_milestones` governs the **governance** axis only. `delivery_mode` is
 *    never written to a milestone under any flag, because `is_milestone`,
 *    `delivery_mode = 'milestone'` and `duration = 0` are three encodings of one
 *    fact and the rollup SQL keys on the third.
 */
function previewRow(
  task: Task,
  isRoot: boolean,
  spec: ClassificationSpec,
  governance: AxisTally,
  delivery: AxisTally,
): { changed: boolean; withheld: boolean } {
  let changed = false;
  let withheld = false;

  if (spec.governanceClass !== null) {
    const inherited = task.parentGovernanceInherited ?? true;
    if (task.isMilestone && spec.skipMilestones) {
      withheld = true;
    } else if (!isRoot && spec.preserveGovernanceOverrides && !inherited) {
      governance.overridesKept += 1;
    } else {
      const targetBit = !isRoot;
      const current = task.governanceClass ?? DEFAULT_GOVERNANCE;
      if (current !== spec.governanceClass || inherited !== targetBit) {
        governance.applied += 1;
        changed = true;
      } else {
        governance.unchanged += 1;
      }
    }
  }

  if (spec.deliveryMode !== null) {
    if (task.isMilestone) {
      withheld = true;
    } else if ((task.deliveryMode ?? DEFAULT_DELIVERY) !== spec.deliveryMode) {
      delivery.applied += 1;
      changed = true;
    } else {
      delivery.unchanged += 1;
    }
  }

  return { changed, withheld };
}

export function previewClassification(
  tasks: Task[],
  spec: ClassificationSpec,
): ClassificationPreviewResult {
  const rows = resolveSubtree(tasks, spec.subtreeId, spec.cascade);
  const governance: AxisTally = { applied: 0, unchanged: 0, overridesKept: 0 };
  const delivery: AxisTally = { applied: 0, unchanged: 0, overridesKept: 0 };
  let tasksChanged = 0;
  let milestonesSkipped = 0;

  for (const task of rows) {
    const { changed, withheld } = previewRow(
      task,
      task.id === spec.subtreeId,
      spec,
      governance,
      delivery,
    );
    if (changed) tasksChanged += 1;
    if (withheld) milestonesSkipped += 1;
  }

  return {
    matched: rows.length,
    tasksChanged,
    milestonesSkipped,
    governance:
      spec.governanceClass === null
        ? null
        : {
            applied: governance.applied,
            unchanged: governance.unchanged,
            overridesKept: governance.overridesKept,
          },
    deliveryMode:
      spec.deliveryMode === null
        ? null
        : { applied: delivery.applied, unchanged: delivery.unchanged, overridesKept: null },
  };
}

/** The three presets the popover offers, each writing **both** axes. */
export const CLASSIFICATION_PRESETS = [
  {
    key: 'gated',
    label: 'Gated',
    governanceClass: 'gated' as GovernanceClass,
    deliveryMode: 'waterfall' as DeliveryMode,
  },
  {
    key: 'scrum',
    label: 'Scrum',
    governanceClass: 'flow' as GovernanceClass,
    deliveryMode: 'scrum' as DeliveryMode,
  },
  {
    key: 'flow',
    label: 'Flow',
    governanceClass: 'flow' as GovernanceClass,
    deliveryMode: 'kanban' as DeliveryMode,
  },
] as const;

export type ClassificationPresetKey = (typeof CLASSIFICATION_PRESETS)[number]['key'];

/** The preset matching the current pair, or null for a combination no preset names. */
export function matchingPreset(
  governanceClass: GovernanceClass | null,
  deliveryMode: DeliveryMode | null,
): ClassificationPresetKey | null {
  const hit = CLASSIFICATION_PRESETS.find(
    (p) => p.governanceClass === governanceClass && p.deliveryMode === deliveryMode,
  );
  return hit ? hit.key : null;
}
