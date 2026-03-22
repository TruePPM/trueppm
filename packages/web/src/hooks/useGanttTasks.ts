// Stub hook — returns fixture data until real API hooks are wired in.
// Replace the body with a real useQuery call; the return type is stable.
import { FIXTURE_TASKS, FIXTURE_LINKS } from '@/fixtures/tasks';
import type { Task, TaskLink } from '@/types';

export interface UseGanttTasksResult {
  tasks: Task[] | undefined;
  links: TaskLink[] | undefined;
  isLoading: boolean;
  error: Error | null;
}

export function useGanttTasks(projectId?: string): UseGanttTasksResult {
  void projectId; // stub — real hook will use this
  return { tasks: FIXTURE_TASKS, links: FIXTURE_LINKS, isLoading: false, error: null };
}
