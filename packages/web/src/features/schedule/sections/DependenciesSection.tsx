import { useScheduleTasks } from '@/hooks/useScheduleTasks';
import { useProject } from '@/hooks/useProject';
import type { DrawerSectionProps } from '@/lib/widget-registry';
import { DependenciesTab } from '../DependenciesTab';

/**
 * Dependencies section — wraps the existing DependenciesTab. Reads tasks +
 * links from the shared schedule cache so the section is self-contained per
 * ADR-0050 (drawer passes only taskId/projectId). `programId` is resolved
 * here via `useProject` rather than added to `DrawerSectionProps` — that
 * interface is a stable extension point Enterprise registers against
 * (ADR-0050), so sections fetch scope-specific data themselves instead of
 * widening the shared contract.
 */
export function DependenciesSection({ taskId, projectId }: DrawerSectionProps) {
  const { tasks, links } = useScheduleTasks();
  const { data: projectDetail } = useProject(projectId);
  const task = tasks?.find((t) => t.id === taskId);

  if (!task) return null;

  return (
    <DependenciesTab
      task={task}
      tasks={tasks ?? []}
      links={links ?? []}
      projectId={projectId}
      programId={projectDetail?.program ?? null}
    />
  );
}
