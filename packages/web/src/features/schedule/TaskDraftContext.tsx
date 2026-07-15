import { createContext, useContext } from 'react';

/**
 * The three-point estimate columns that batch behind the drawer Save bar (#1985,
 * ADR-0440). Keys are the wire (snake_case) names so a section can spread them
 * straight into a task PATCH.
 */
export interface EstimateDraftValue {
  optimistic_duration: number | null;
  most_likely_duration: number | null;
  pessimistic_duration: number | null;
}

export interface TaskDraftContextValue {
  /**
   * The task this draft is seeded for. A registry section consuming the context
   * must ignore a draft whose `taskId` does not match its own task — guards
   * against a stale read during a canvas swap mid-render.
   */
  taskId: string;
  /** Current staged estimate values (the drawer's uncommitted draft). */
  estimates: EstimateDraftValue;
  /** Stage an estimate edit into the drawer draft — no PATCH until the Save bar fires. */
  setEstimate: (key: keyof EstimateDraftValue, value: number | null) => void;
  /** Which estimate fields differ from the last-saved baseline — drives the per-field • markers. */
  changed: Record<keyof EstimateDraftValue, boolean>;
  /**
   * Re-baseline the estimate slice to a value the server just applied out-of-band
   * (the velocity-suggestion Accept path, ADR-0065), without disturbing an
   * in-progress name/description edit. Prevents a later Save from re-PATCHing a
   * stale baseline over the accepted value.
   */
  commitEstimatesFromServer: (estimates: EstimateDraftValue) => void;
}

/**
 * Drawer-scoped context that lets a registry section (currently only
 * `EstimatesTab`) stage its edits into the task-detail drawer's Save/Cancel draft
 * (#1985, ADR-0440) instead of committing immediately.
 *
 * The default is `null`: a `null` value from {@link useTaskDraft} is the
 * "no drawer draft present" signal, and the consumer falls back to its own
 * immediate mutation (e.g. the full-page `TaskDetailPage`, which has no Save bar).
 *
 * Delivering the draft via context — rather than a new prop — keeps the
 * `DrawerSectionProps` registry contract (ADR-0050 / ADR-0133) unchanged, so
 * Enterprise sections that never read this context are wholly unaffected.
 */
export const TaskDraftContext = createContext<TaskDraftContextValue | null>(null);

/** Returns the drawer's estimate draft, or `null` when no draft is present. */
export function useTaskDraft(): TaskDraftContextValue | null {
  return useContext(TaskDraftContext);
}
