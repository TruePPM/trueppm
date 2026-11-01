import { create } from 'zustand';
import type { LastTask } from '@/lib/lastTask';

/**
 * In-memory hand-off for "the task the user just opened" (#1211).
 *
 * `TaskDetailDrawer` renders in many hosts and many unit tests without a
 * `QueryClient`, so it cannot resolve the current user itself. It writes the
 * opened task here instead, and `<LastTaskRecorder>` (mounted in the app shells,
 * where the user is known) persists it per user.
 */
interface LastTaskState {
  opened: LastTask | null;
  setOpened: (task: LastTask) => void;
}

export const useLastTaskStore = create<LastTaskState>()((set) => ({
  opened: null,
  setOpened: (opened) => set({ opened }),
}));
