import { useScheduleTasks } from '@/hooks/useScheduleTasks';
import { useProject } from '@/hooks/useProject';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { canAuthorDependencies } from '@/lib/roles';
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
export function DependenciesSection({ taskId, projectId, userRole }: DrawerSectionProps) {
  const { tasks, links } = useScheduleTasks();
  const { data: projectDetail } = useProject(projectId);
  const { isError: roleError } = useCurrentUserRole(projectId);
  const task = tasks?.find((t) => t.id === taskId);

  /**
   * Edges are `IsProjectScheduler`; task content is `IsProjectPlanAuthor`
   * (ADR-0773 §7). Neither band contains the other, so `canEdit` — which this
   * section is handed and which `widget-registry` itself warns is "wrong for
   * Scheduler" — cannot answer this question. `canAuthorDependencies` can.
   *
   * A FAILED role read is OR'd back in as rights, per the resolver's own
   * contract: it sees only the ordinal and cannot separate loading, no
   * membership, and a dropped request. `useCurrentUserRole` sets `retry: false`,
   * so one blip is terminal, and treating that as a refusal would strip a
   * Scheduler's only keyboard route to dependency authoring for the life of the
   * page. Loading stays pessimistic (absent for a beat, never a flash-then-403);
   * the server is the enforcement point either way. Mirrors
   * `ScheduleView`'s `dependenciesReadOnly` (#2961, #3053).
   */
  const canWrite = (roleError ?? false) || canAuthorDependencies(userRole);

  if (!task) return null;

  return (
    <DependenciesTab
      task={task}
      tasks={tasks ?? []}
      links={links ?? []}
      projectId={projectId}
      programId={projectDetail?.program ?? null}
      canWrite={canWrite}
    />
  );
}
