/**
 * Schedule reconciliation store (ADR-0784, issue #2725).
 *
 * Holds the gap between what the planner authored and what the server decided,
 * so a date the engine moves is never silent.
 *
 * Why a store and not React Query meta or component state (ADR-0784 §D2):
 *   - `meta` is replaced by the very refetch that carries the authoritative
 *     dates it would have to survive;
 *   - component state dies on a tab switch, and the marker must persist *until
 *     acknowledged*, not until the planner navigates away.
 *
 * All the logic lives in the pure reducer in
 * `features/schedule/reconcile/reconcileState.ts` — this is a thin zustand
 * wrapper so the state machine can be unit-tested without a renderer.
 */
import { create } from 'zustand';

import { MON_FRI_MASK } from '@/features/schedule/reconcile/reconcileCopy';
import {
  acknowledge,
  acknowledgeAllDiverged,
  prune,
  reconcile,
  reconcileKey,
  registerPreview,
  reject,
  type PreviewInput,
  type ReconcileEntries,
  type ReconcileField,
  type ReconcileObservation,
} from '@/features/schedule/reconcile/reconcileState';

interface ReconcileState {
  /** Project the entries belong to. A switch clears everything (ADR-0784 §D1). */
  projectId: string | null;
  entries: ReconcileEntries;
  /** "Show N changes" — narrows the outline to rows carrying a marker (§D8). */
  reviewFilterActive: boolean;
  /**
   * The project's effective working-day bitmask, published by `ScheduleView`.
   * The sole input to the cause qualifier — and the only cause the client can
   * prove (ADR-0784 §D5). Defaults to Mon–Fri, matching the server's own
   * `working_day_duration` fallback.
   */
  workingDaysMask: number;

  setProject: (projectId: string | null) => void;
  setWorkingDaysMask: (mask: number) => void;
  registerPreview: (input: PreviewInput) => void;
  observe: (observations: readonly ReconcileObservation[]) => void;
  reject: (
    taskId: string,
    field: ReconcileField,
    reason: string,
    retry?: (() => void) | null,
  ) => void;
  /** Re-issue a refused write. The mutation's `onMutate` re-opens the preview. */
  retry: (taskId: string, field: ReconcileField) => void;
  acknowledge: (taskId: string, field: ReconcileField) => void;
  acknowledgeAll: () => void;
  prune: (knownTaskIds?: ReadonlySet<string>) => void;
  setReviewFilter: (active: boolean) => void;
}

const EMPTY: ReconcileEntries = {};

export const useReconcileStore = create<ReconcileState>((set, get) => ({
  projectId: null,
  entries: EMPTY,
  reviewFilterActive: false,
  workingDaysMask: MON_FRI_MASK,

  setWorkingDaysMask: (workingDaysMask) => {
    if (get().workingDaysMask === workingDaysMask) return;
    set({ workingDaysMask });
  },

  setProject: (projectId) => {
    if (get().projectId === projectId) return;
    // Entries are per-project by construction; carrying them across a switch
    // would mark rows in a plan the user never edited.
    set({ projectId, entries: EMPTY, reviewFilterActive: false });
  },

  registerPreview: (input) =>
    set((s) => ({ entries: registerPreview(s.entries, input, Date.now()) })),

  observe: (observations) =>
    set((s) => ({ entries: reconcile(s.entries, observations, Date.now()) })),

  reject: (taskId, field, reason, retry = null) =>
    set((s) => ({ entries: reject(s.entries, taskId, field, reason, retry) })),

  retry: (taskId, field) => {
    const entry = get().entries[reconcileKey(taskId, field)];
    if (!entry) return;
    // Drop the rejection first: the re-issued mutation's `onMutate` opens a
    // fresh preview, and leaving the old entry would let a stale reason outlive
    // the write it described if the retry succeeds.
    set((s) => ({ entries: acknowledge(s.entries, taskId, field) }));
    entry.retry?.();
  },

  acknowledge: (taskId, field) =>
    set((s) => {
      const entries = acknowledge(s.entries, taskId, field);
      return { entries, ...clearFilterIfEmpty(entries, s.reviewFilterActive) };
    }),

  acknowledgeAll: () =>
    set((s) => {
      const entries = acknowledgeAllDiverged(s.entries);
      return { entries, ...clearFilterIfEmpty(entries, s.reviewFilterActive) };
    }),

  prune: (knownTaskIds) =>
    set((s) => {
      const entries = prune(s.entries, Date.now(), knownTaskIds);
      if (entries === s.entries) return s;
      return { entries, ...clearFilterIfEmpty(entries, s.reviewFilterActive) };
    }),

  setReviewFilter: (reviewFilterActive) => set({ reviewFilterActive }),
}));

/**
 * Turn the review filter off once nothing is left to review.
 *
 * Without this, acknowledging the last change leaves the outline filtered to an
 * empty set — which reads as "your project is gone", not "you're done"
 * (ADR-0784 §D8).
 */
function clearFilterIfEmpty(
  entries: ReconcileEntries,
  active: boolean,
): { reviewFilterActive?: boolean } {
  if (!active) return {};
  const hasMarker = Object.values(entries).some(
    (e) => e.status === 'diverged' || e.status === 'rejected',
  );
  return hasMarker ? {} : { reviewFilterActive: false };
}
