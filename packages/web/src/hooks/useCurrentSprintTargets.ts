import { useMemo } from 'react';

import { useProjects } from './useProjects';
import { useActiveSprint } from './useSprints';
import { useMyActiveSprints } from './useMyActiveSprints';

/** One "jump to current sprint" destination — a project's live ACTIVE sprint. */
export interface SprintJumpTarget {
  projectId: string;
  projectName: string;
  sprintId: string;
  sprintName: string;
  /** Board deep-link scoped to this sprint via the shareable `?sprint=` axis. */
  path: string;
}

/** Board URL scoped to a specific sprint. `?sprint=` is authoritative in
 *  BoardView (a shared link wins over the smart default), so this lands the
 *  user directly on that sprint's board. */
function boardPath(projectId: string, sprintId: string): string {
  return `/projects/${projectId}/board?sprint=${sprintId}`;
}

/**
 * The user's "jump to current sprint" targets (issue 1594) — the single source of
 * truth behind BOTH the pinned shell control and the top-ranked ⌘K action, so
 * the two surfaces can never drift (web-rule 214).
 *
 * Two sources, de-duplicated by sprint id and ordered "here first":
 *  1. The in-context project's ACTIVE sprint (when `currentProjectId` is set).
 *     Ownership-independent — a Scrum Master who facilitates a sprint but owns
 *     none of its tasks still gets their own board (the issue 1594 persona). Gated on
 *     the project not being WATERFALL: schedule-first projects have no SPRINT
 *     view group (ADR-0195), so they never yield a sprint target.
 *  2. The cross-team `/me/active-sprints/` lens — every other team whose active
 *     sprint the user has work in, pre-sorted server-side by burndown deviation.
 *     Only sprint-running projects can appear there, so no methodology gate is
 *     needed on this branch.
 *
 * An empty list means "no active sprint anywhere" — callers render nothing
 * rather than a dead control.
 */
export function useCurrentSprintTargets(
  currentProjectId: string | null | undefined,
): SprintJumpTarget[] {
  const { data: projects } = useProjects();
  const { sprint: inContextSprint } = useActiveSprint(currentProjectId ?? null);
  const { data: myActiveSprints } = useMyActiveSprints();

  return useMemo(() => {
    const targets: SprintJumpTarget[] = [];
    const seen = new Set<string>();

    if (currentProjectId && inContextSprint) {
      const project = projects?.find((p) => p.id === currentProjectId);
      // WATERFALL projects cannot run sprints (sprints tab hidden, ADR-0195); the
      // matching inline gate used for backlog targets in useCommandItems.
      if ((project?.methodology ?? 'HYBRID') !== 'WATERFALL') {
        targets.push({
          projectId: currentProjectId,
          projectName: project?.name ?? 'This project',
          sprintId: inContextSprint.id,
          sprintName: inContextSprint.name,
          path: boardPath(currentProjectId, inContextSprint.id),
        });
        seen.add(inContextSprint.id);
      }
    }

    for (const entry of myActiveSprints ?? []) {
      if (seen.has(entry.sprint.id)) continue;
      seen.add(entry.sprint.id);
      targets.push({
        projectId: entry.project_id,
        projectName: entry.project_name,
        sprintId: entry.sprint.id,
        sprintName: entry.sprint.name,
        path: boardPath(entry.project_id, entry.sprint.id),
      });
    }

    return targets;
  }, [currentProjectId, inContextSprint, projects, myActiveSprints]);
}
