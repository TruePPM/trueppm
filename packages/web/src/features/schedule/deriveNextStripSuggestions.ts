import type { Task, TaskLink } from '@/types';

/**
 * One suggestion in the Next strip (#2731, ADR-0799 §4).
 *
 * Fixed, small vocabulary — a new suggestion type is a new predicate added to
 * {@link deriveNextStripSuggestions}, not a new mechanism. `id` is stable across
 * renders so the strip's `role="status"` live text and any per-suggestion action
 * can key off it without re-deriving order.
 */
export interface NextStripSuggestion {
  id: 'unowned' | 'unconfirmedGates' | 'undeclaredBranches';
  count: number;
  /** "3 tasks have no owner yet" — plural-safe, ready to render as-is. */
  label: string;
}

/**
 * Derive the Next strip's suggestions from the already-loaded schedule (ADR-0799 §4).
 *
 * A pure function over data the Schedule page already has — no request of its own.
 * All three signals are scoped to `isUntouchedSeed` rows on purpose: the strip is
 * about *this plan, freshly seeded*, not a general project-health lint (that is the
 * reconcile strip's and the Board's stale-task nudge's job). A row a person has
 * since edited has already been looked at and drops out of every signal here, the
 * same way it drops out of the tick mark and the delete sweep — one provenance
 * predicate (`isUntouchedSeed`), several consumers, never re-derived per consumer.
 *
 * Order is fixed (unowned → unconfirmed gates → undeclared branches), not re-sorted
 * by count — a stable order across renders matters more than value-ranking three
 * numbers a user reads in under a second. Suggestions with a zero count are omitted;
 * the caller (`NextStrip`) renders nothing when the returned array is empty.
 */
export function deriveNextStripSuggestions(
  tasks: readonly Task[],
  links: readonly Pick<TaskLink, 'sourceId' | 'targetId'>[],
): NextStripSuggestion[] {
  const suggestions: NextStripSuggestion[] = [];

  // Unowned: a leaf (non-summary), non-milestone, untouched-seeded task with no
  // resource assignment. `assignees` (TaskResource-backed) is the load-bearing
  // ownership signal in this codebase — never the bare per-task assignee field,
  // which capacity/utilization also ignore for the same reason.
  const unowned = tasks.filter(
    (t) => !t.isSummary && !t.isMilestone && t.isUntouchedSeed && t.assignees.length === 0,
  ).length;
  if (unowned > 0) {
    suggestions.push({
      id: 'unowned',
      count: unowned,
      label: unowned === 1 ? '1 task has no owner yet' : `${unowned} tasks have no owner yet`,
    });
  }

  // Unconfirmed gates: a milestone nobody has looked at since the template wrote
  // it — a zero-duration commitment date sitting exactly where the template put it.
  const unconfirmedGates = tasks.filter((t) => t.isMilestone && t.isUntouchedSeed).length;
  if (unconfirmedGates > 0) {
    suggestions.push({
      id: 'unconfirmedGates',
      count: unconfirmedGates,
      label:
        unconfirmedGates === 1
          ? "1 milestone hasn't been confirmed"
          : `${unconfirmedGates} milestones haven't been confirmed`,
    });
  }

  // Undeclared branches: a top-level (WBS depth 1) phase, still untouched-seeded,
  // whose descendant subtree carries zero dependency edges — a branch nobody has
  // connected to the rest of the plan. Depth is read off `wbs` (dot-separated),
  // the same convention `plannedByPhase.ts` / `TaskListPanel.tsx` already use for
  // "is this a top-level phase" — never re-derived from `parentId` walking.
  const topLevelPhases = tasks.filter(
    (t) => t.isSummary && t.isUntouchedSeed && t.wbs.split('.').length === 1,
  );
  if (topLevelPhases.length > 0) {
    const linkedTaskIds = new Set<string>();
    for (const link of links) {
      linkedTaskIds.add(link.sourceId);
      linkedTaskIds.add(link.targetId);
    }
    const undeclaredBranches = topLevelPhases.filter((phase) => {
      const prefix = `${phase.wbs}.`;
      const subtreeIds = tasks
        .filter((t) => t.id === phase.id || t.wbs.startsWith(prefix))
        .map((t) => t.id);
      return subtreeIds.every((id) => !linkedTaskIds.has(id));
    }).length;
    if (undeclaredBranches > 0) {
      suggestions.push({
        id: 'undeclaredBranches',
        count: undeclaredBranches,
        label:
          undeclaredBranches === 1
            ? "1 phase isn't connected to the rest of the plan"
            : `${undeclaredBranches} phases aren't connected to the rest of the plan`,
      });
    }
  }

  return suggestions;
}
