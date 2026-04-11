/**
 * useTaskRun — subscribe to a specific task run's live progress.
 *
 * Returns the current TaskRunEntry from the store (updated in real time
 * by useProjectWebSocket events). Returns null if the run is not yet known.
 *
 * Usage (inside a component that also mounts useProjectWebSocket):
 *   const run = useTaskRun(taskRunId);
 *   if (run) return <ProgressBar pct={run.pct} label={run.msg} />;
 */
import { useTaskRunStore } from '@/stores/taskRunStore';
import type { TaskRunEntry } from '@/stores/taskRunStore';

export function useTaskRun(taskRunId: string | null | undefined): TaskRunEntry | null {
  const entry = useTaskRunStore((s) => (taskRunId ? s.runs[taskRunId] : undefined));
  return entry ?? null;
}
