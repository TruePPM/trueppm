import { useScheduleTasks } from '@/hooks/useScheduleTasks';
import { useActiveSprint } from '@/hooks/useSprints';
import { ROLE_SCHEDULER, ROLE_ADMIN, canEditTask } from '@/lib/roles';
import type { DrawerSectionProps } from '@/lib/widget-registry';
import type { Task } from '@/types';
import { EstimatesTab } from '../EstimatesTab';
import { PhaseUncertaintyBlock } from '../PhaseUncertaintyBlock';

/**
 * Estimates section — wraps the existing EstimatesTab. Defaults to estimation
 * mode 'open' (matching previous drawer default) until project-level
 * methodology lookup is wired (TODO follow-up). Gates the EstimatesTab write
 * access on the threaded `canEdit` verdict + role floor (see below).
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
export function EstimatesSection({ taskId, projectId, userRole, canEdit }: DrawerSectionProps) {
  const { tasks } = useScheduleTasks();
  const task = tasks?.find((t) => t.id === taskId);
  // Gate O/M/P editability on the threaded server per-task verdict (ADR-0133),
  // AND the estimates-specific Scheduler/Admin floor — in one place, not a
  // separate useCurrentUserRole fork. Previously this section re-derived from
  // role alone, so a task the server marked non-editable (e.g. Member on
  // someone else's task, or the PO edge cases) still showed editable estimate
  // inputs while every sibling control was read-only, or vice versa (#2154).
  const effectiveCanEdit = canEdit ?? canEditTask(userRole);
  const userIsScheduler = effectiveCanEdit && userRole != null && userRole >= ROLE_SCHEDULER;
  const userIsAdmin = effectiveCanEdit && userRole != null && userRole >= ROLE_ADMIN;
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
