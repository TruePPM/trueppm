import { useScheduleTasks } from '@/hooks/useScheduleTasks';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { useActiveSprint } from '@/hooks/useSprints';
import type { DrawerSectionProps } from '@/lib/widget-registry';
import type { Task } from '@/types';
import { EstimatesTab } from '../EstimatesTab';
import { PhaseUncertaintyBlock } from '../PhaseUncertaintyBlock';

/**
 * Estimates section — wraps the existing EstimatesTab. Defaults to estimation
 * mode 'open' (matching previous drawer default) until project-level
 * methodology lookup is wired (TODO follow-up). Reads scheduler role from
 * useCurrentUserRole so the EstimatesTab gates write access correctly.
 *
 * Passes sprintIsActive so EstimatesTab can gate the remaining-points input
 * to the period when the sprint is running (issue #366).
 *
 * Summary tasks never expose editable O/M/P fields — the MC engine samples
 * only leaf task durations; PERT values on a phase task are silently ignored.
 * When a summary task has at least one descendant with PERT estimates we show
 * PhaseUncertaintyBlock instead; when no descendants have estimates we hide
 * the section entirely (#403).
 */
export function EstimatesSection({ taskId, projectId }: DrawerSectionProps) {
  const { tasks } = useScheduleTasks();
  const task = tasks?.find((t) => t.id === taskId);
  const { role } = useCurrentUserRole(projectId);
  const userIsScheduler = role !== null && role >= 2;
  const userIsAdmin = role !== null && role >= 3;
  const { sprint: activeSprint } = useActiveSprint(projectId);

  if (!task) return null;

  if (task.isSummary) {
    if (!hasDescendantPert(tasks ?? [], task.id)) return null;
    return <PhaseUncertaintyBlock projectId={projectId} />;
  }

  const sprintIsActive = !!task.sprintId && activeSprint?.id === task.sprintId;

  return (
    <EstimatesTab
      task={task}
      projectId={projectId}
      estimationMode="open"
      userIsScheduler={userIsScheduler}
      userIsAdmin={userIsAdmin}
      sprintIsActive={sprintIsActive}
    />
  );
}

/** Returns true if any descendant of `parentId` has an optimisticDuration set. */
function hasDescendantPert(tasks: Task[], parentId: string): boolean {
  for (const t of tasks) {
    if (t.parentId === parentId) {
      if (t.optimisticDuration != null) return true;
      if (hasDescendantPert(tasks, t.id)) return true;
    }
  }
  return false;
}
