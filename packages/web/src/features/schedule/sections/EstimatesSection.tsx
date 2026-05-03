import { useScheduleTasks } from '@/hooks/useScheduleTasks';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import type { DrawerSectionProps } from '@/lib/widget-registry';
import { EstimatesTab } from '../EstimatesTab';

/**
 * Estimates section — wraps the existing EstimatesTab. Defaults to estimation
 * mode 'open' (matching previous drawer default) until project-level
 * methodology lookup is wired (TODO follow-up). Reads scheduler role from
 * useCurrentUserRole so the EstimatesTab gates write access correctly.
 */
export function EstimatesSection({ taskId, projectId }: DrawerSectionProps) {
  const { tasks } = useScheduleTasks();
  const task = tasks?.find((t) => t.id === taskId);
  const { role } = useCurrentUserRole(projectId);
  const userIsScheduler = role !== null && role >= 2;

  if (!task) return null;

  return (
    <EstimatesTab
      task={task}
      projectId={projectId}
      estimationMode="open"
      userIsScheduler={userIsScheduler}
    />
  );
}
