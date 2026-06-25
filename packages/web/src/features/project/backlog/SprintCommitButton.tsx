import type { MouseEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { Button } from '@/components/Button';
import { useUpdateTask } from '@/hooks/useTaskMutations';
import type { Task } from '@/types';
import { SprintCommitmentChip } from './components/atoms';

/** Minimal planned-sprint reference the commit toggle needs. */
export interface PlannedSprintRef {
  id: string;
  short_id_display: string;
}

interface Props {
  story: Task;
  projectId: string;
  /** The sprint currently in PLANNED state, or null when none is being planned. */
  plannedSprint: PlannedSprintRef | null;
  canManage: boolean;
}

/**
 * The Sprint cell on the Product Backlog (issue 1291). When a sprint is in
 * PLANNED state and the reader can manage the backlog, the read-only
 * sprint-commitment chip (rule 180) becomes a one-click commit toggle into that
 * sprint — the heart of the unified planning rail, so the Product Owner commits
 * stories until capacity is full without leaving the backlog. Otherwise it falls
 * back to the read-only chip (today's behavior).
 *
 * A story already committed to a DIFFERENT (e.g. active) sprint stays read-only
 * here: it is committed elsewhere and must not be moved from the planning surface.
 *
 * `useUpdateTask` only patches the ['tasks'] cache, so we invalidate
 * ['product-backlog'] on success — that query drives both this row and the rail's
 * derived committed-points count.
 */
export function SprintCommitButton({ story, projectId, plannedSprint, canManage }: Props) {
  const queryClient = useQueryClient();
  const updateTask = useUpdateTask();

  if (!plannedSprint || !canManage) return <SprintCommitmentChip story={story} />;
  if (story.sprintId && story.sprintId !== plannedSprint.id) {
    return <SprintCommitmentChip story={story} />;
  }

  const inSprint = story.sprintId === plannedSprint.id;
  const toggle = (e: MouseEvent) => {
    e.stopPropagation(); // the row itself opens the story drawer
    updateTask.mutate(
      { id: story.id, projectId, sprint: inSprint ? null : plannedSprint.id },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: ['product-backlog', projectId] });
        },
      },
    );
  };

  return (
    <Button
      variant={inSprint ? 'primary' : 'secondary'}
      size="sm"
      onClick={toggle}
      disabled={updateTask.isPending}
      aria-label={
        inSprint
          ? `Remove ${story.name} from ${plannedSprint.short_id_display}`
          : `Add ${story.name} to ${plannedSprint.short_id_display}`
      }
    >
      {inSprint ? '✓ In' : '+ Add'}
    </Button>
  );
}
