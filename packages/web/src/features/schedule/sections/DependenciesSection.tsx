import { useScheduleTasks } from '@/hooks/useScheduleTasks';
import type { DrawerSectionProps } from '@/lib/widget-registry';
import { DependenciesTab } from '../DependenciesTab';

/**
 * Dependencies section — wraps the existing DependenciesTab. Reads tasks +
 * links from the shared schedule cache so the section is self-contained per
 * ADR-0050 (drawer passes only taskId/projectId).
 */
export function DependenciesSection({ taskId, projectId }: DrawerSectionProps) {
  const { tasks, links } = useScheduleTasks();
  const task = tasks?.find((t) => t.id === taskId);

  if (!task) return null;

  return (
    <DependenciesTab
      task={task}
      tasks={tasks ?? []}
      links={links ?? []}
      projectId={projectId}
    />
  );
}
