import { TaskDetailDrawer } from '@/features/schedule/TaskDetailDrawer';
import { useTaskDrawerStore } from '@/stores/taskDrawerStore';

/**
 * App-wide host for the task-detail drawer opened from the ⌘K palette (ADR-0136,
 * issue 647). Mounted once in `AppShell`; renders the existing `TaskDetailDrawer`
 * driven by `taskDrawerStore` so a power user can open a task and edit it inline
 * from any route, without navigating to the Gantt.
 *
 * Renders nothing until the palette sets a task — so its hooks (and the drawer's)
 * stay inert on every page until the feature is actually used.
 */
export function GlobalTaskDrawer() {
  const task = useTaskDrawerStore((s) => s.task);
  const projectId = useTaskDrawerStore((s) => s.projectId);
  const close = useTaskDrawerStore((s) => s.close);

  if (!task || !projectId) return null;

  return <TaskDetailDrawer task={task} projectId={projectId} onClose={close} />;
}
