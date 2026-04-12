/**
 * useCalendarTasks — stub hook returning fixture tasks for CalendarView.
 *
 * Replaced by a real TanStack Query hook in issue #55 follow-up once the
 * ?project= param is available from the router.
 */

import type { Task } from '@/types';

const FIXTURE_TASKS: Task[] = [
  {
    id: 'task-1',
    wbs: '1',
    name: 'Project Kickoff',
    start: '2026-03-02',
    finish: '2026-03-02',
    duration: 1,
    progress: 100,
    parentId: null,
    isCritical: true,
    isComplete: true,
    isSummary: false,
    isMilestone: true,
    status: 'COMPLETE',
  },
  {
    id: 'task-2',
    wbs: '2',
    name: 'Requirements Analysis',
    start: '2026-03-03',
    finish: '2026-03-13',
    duration: 9,
    progress: 60,
    parentId: null,
    isCritical: true,
    isComplete: false,
    isSummary: false,
    isMilestone: false,
    status: 'IN_PROGRESS',
  },
  {
    id: 'task-3',
    wbs: '3',
    name: 'Architecture Design',
    start: '2026-03-10',
    finish: '2026-03-20',
    duration: 9,
    progress: 20,
    parentId: null,
    isCritical: false,
    isComplete: false,
    isSummary: false,
    isMilestone: false,
    status: 'IN_PROGRESS',
  },
  {
    id: 'task-4',
    wbs: '4',
    name: 'UI Wireframes',
    start: '2026-03-16',
    finish: '2026-03-27',
    duration: 10,
    progress: 0,
    parentId: null,
    isCritical: false,
    isComplete: false,
    isSummary: false,
    isMilestone: false,
    status: 'NOT_STARTED',
  },
  {
    id: 'task-5',
    wbs: '5',
    name: 'Design Review Gate',
    start: '2026-03-27',
    finish: '2026-03-27',
    duration: 0,
    progress: 0,
    parentId: null,
    isCritical: true,
    isComplete: false,
    isSummary: false,
    isMilestone: true,
    status: 'NOT_STARTED',
  },
];

interface UseCalendarTasksReturn {
  tasks: Task[];
  isLoading: boolean;
}

export function useCalendarTasks(): UseCalendarTasksReturn {
  return { tasks: FIXTURE_TASKS, isLoading: false };
}
