import { create } from 'zustand';
import type { Task } from '@/types';

/**
 * App-wide task-detail drawer state (ADR-0136, issue 647).
 *
 * The ⌘K palette opens a task for editing from *any* route without navigating
 * to the Gantt — it writes the chosen task here and `<GlobalTaskDrawer>` (mounted
 * once in `AppShell`) renders the existing `TaskDetailDrawer` from it.
 *
 * This is deliberately separate from `scheduleStore.selectedTaskId` (which drives
 * the Schedule view's own drawer) and BoardView's local state, so lifting a
 * palette-initiated drawer app-wide neither double-opens with nor refactors those
 * view-local mounts. The palette is the only writer of this store.
 */
interface TaskDrawerState {
  /** The task to render in the drawer, or null when closed. */
  task: Task | null;
  /** The task's project — supplies the drawer's role/edit-capability gate. */
  projectId: string | null;
  /** Open the drawer on a task. Palette task search is current-project-scoped, so
   *  `projectId` always matches the active route. */
  openTask: (task: Task, projectId: string) => void;
  close: () => void;
}

export const useTaskDrawerStore = create<TaskDrawerState>()((set) => ({
  task: null,
  projectId: null,
  openTask: (task, projectId) => set({ task, projectId }),
  close: () => set({ task: null, projectId: null }),
}));
