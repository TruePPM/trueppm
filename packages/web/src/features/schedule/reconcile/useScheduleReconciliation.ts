/**
 * Feeds server-authoritative task dates into the reconciliation store
 * (ADR-0784 §D3, issue #2725).
 *
 * This is the FULL-SNAPSHOT delivery path: the initial load, any explicit cache
 * invalidation, and `useScheduleTasks`' 30 s fallback poll (which runs only
 * while the WebSocket is not `live`). The per-task delta path is the
 * `task_dates_updated` handler in `useProjectWebSocket`; both call the same
 * `reconcile()` reducer, so the two cannot drift.
 *
 * Because this path sees every task, it is also the one that prunes entries for
 * deleted tasks — the delta path observes a subset and must not.
 */
import { useEffect } from 'react';

import { useReconcileStore } from '@/stores/reconcileStore';
import type { Task } from '@/types';

import { PREVIEW_TTL_MS, type ReconcileObservation } from './reconcileState';

/** How often an idle view re-checks for previews that timed out. */
const PRUNE_INTERVAL_MS = 15_000;

export function useScheduleReconciliation(projectId: string | null, tasks: Task[] | undefined) {
  const setProject = useReconcileStore((s) => s.setProject);
  const observe = useReconcileStore((s) => s.observe);
  const prune = useReconcileStore((s) => s.prune);

  useEffect(() => {
    setProject(projectId);
  }, [projectId, setProject]);

  useEffect(() => {
    if (!tasks) return;
    const observations: ReconcileObservation[] = [];
    for (const t of tasks) {
      observations.push({ taskId: t.id, field: 'start', value: t.start || null });
      observations.push({ taskId: t.id, field: 'finish', value: t.finish || null });
    }
    observe(observations);
    prune(new Set(tasks.map((t) => t.id)));
  }, [tasks, observe, prune]);

  // A preview that never reconciles (socket down AND poll never answered) would
  // otherwise stay italic forever — nothing re-renders the row to trigger a lazy
  // TTL check. One cheap timer per view covers it; `prune` is a no-op returning
  // the same reference when nothing expired, so this does not cause renders.
  useEffect(() => {
    const id = setInterval(() => prune(), PRUNE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [prune]);
}

export { PREVIEW_TTL_MS };
