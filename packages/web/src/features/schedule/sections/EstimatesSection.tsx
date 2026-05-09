import { useScheduleTasks } from '@/hooks/useScheduleTasks';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { useActiveSprint } from '@/hooks/useSprints';
import type { DrawerSectionProps } from '@/lib/widget-registry';
import { EstimatesTab } from '../EstimatesTab';

/**
 * Estimates section — wraps the existing EstimatesTab. Defaults to estimation
 * mode 'open' (matching previous drawer default) until project-level
 * methodology lookup is wired (TODO follow-up). Reads scheduler role from
 * useCurrentUserRole so the EstimatesTab gates write access correctly.
 *
 * Passes sprintIsActive so EstimatesTab can gate the remaining-points input
 * to the period when the sprint is running (issue #366).
 */
export function EstimatesSection({ taskId, projectId }: DrawerSectionProps) {
  const { tasks } = useScheduleTasks();
  const task = tasks?.find((t) => t.id === taskId);
  const { role } = useCurrentUserRole(projectId);
  const userIsScheduler = role !== null && role >= 2;
  const { sprint: activeSprint } = useActiveSprint(projectId);

  if (!task) return null;

  const sprintIsActive = !!task.sprintId && activeSprint?.id === task.sprintId;

  return (
    <EstimatesTab
      task={task}
      projectId={projectId}
      estimationMode="open"
      userIsScheduler={userIsScheduler}
      sprintIsActive={sprintIsActive}
    />
  );
}
