import type { ResourceAssignment } from '@/hooks/useResourceAssignments';

export interface AssignmentProjectGroup {
  projectId: string;
  projectName: string;
  assignments: ResourceAssignment[];
}

/**
 * Group a flat cross-project assignment list into per-project sections for the
 * ResourceDetailPanel Assignments view (#2047). The API orders rows by project
 * name then task name; we preserve that first-seen order for groups and, within
 * each group, keep active work first and completed work last (a stable partition,
 * server order preserved within each half) so the "still winding down" tasks
 * don't bury what's in flight (ADR-0499 §5).
 */
export function groupAssignmentsByProject(
  assignments: ResourceAssignment[],
): AssignmentProjectGroup[] {
  const groups = new Map<string, AssignmentProjectGroup>();
  for (const a of assignments) {
    let group = groups.get(a.projectId);
    if (!group) {
      group = { projectId: a.projectId, projectName: a.projectName, assignments: [] };
      groups.set(a.projectId, group);
    }
    group.assignments.push(a);
  }
  for (const group of groups.values()) {
    // Stable partition: non-completed first, completed last.
    const active = group.assignments.filter((a) => a.status !== 'COMPLETE');
    const done = group.assignments.filter((a) => a.status === 'COMPLETE');
    group.assignments = [...active, ...done];
  }
  return [...groups.values()];
}
