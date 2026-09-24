import { create } from 'zustand';
import {
  readDemoTips,
  writeDemoTips,
  visibleState,
  type DemoTipsState,
} from '@/features/shell/demoTips';

/**
 * Cross-surface state for the read-only demo's landing hint (#4050 A1/A6).
 *
 * The hint lives in the merged demo bar, which is mounted by `AppShell` —
 * above the router outlet — while the two things it talks about (the task bar
 * it wants dragged, the forecast it wants opened) live inside `ScheduleView`.
 * A store rather than context because the relationship is *sparse*: two
 * components, no tree between them worth threading a provider through, and the
 * Schedule already drives the unscheduled tray through `scheduleStore` by
 * exactly this pattern.
 *
 * Nothing here is a permission or a mode. `authorRequest` is a nonce the
 * Schedule watches — a bump means "the visitor pressed Try it", and the
 * Schedule decides what that means (enter Author for the session, scroll to and
 * pulse the target bar). Modelled as a counter rather than a boolean so a
 * second press re-fires the scroll instead of being swallowed as "already
 * true", the same reason `revealGutterSprint` carries a nonce.
 */
interface DemoTipsStore {
  /** Which step the bar is showing, or that the visitor closed it. */
  state: DemoTipsState;
  /** Bumped by "Try it". The Schedule reacts; it is not a mode. */
  authorRequest: number;
  /**
   * The task the hint names — published by the Schedule, read by the bar.
   *
   * The bar cannot derive it: it has no task list. The Schedule picks the one
   * task Part B's overlay leaves behind plan, by its schedule data rather than
   * by display name (#4050 A6), and publishes id + name here.
   */
  target: { id: string; name: string } | null;
  setTarget: (target: { id: string; name: string } | null) => void;
  requestAuthor: () => void;
  /** A real drag landed — advance step 1 → step 2. Idempotent afterwards. */
  advanceAfterDrag: () => void;
  dismiss: () => void;
  /** "Tips" — bring a dismissed hint back at step 1. */
  restore: () => void;
}

export const useDemoTipsStore = create<DemoTipsStore>()((set, get) => ({
  // Read at module init rather than in an effect: the bar's first paint is the
  // landing frame, and a hint that appears and then vanishes is worse than one
  // that was never shown.
  state: visibleState(readDemoTips()),
  authorRequest: 0,
  target: null,
  setTarget: (target) => {
    // Guard the write so a Schedule re-render with an equal target does not
    // notify every subscriber — this store is read by the always-mounted bar.
    const current = get().target;
    if (current?.id === target?.id && current?.name === target?.name) return;
    set({ target });
  },
  requestAuthor: () => set((s) => ({ authorRequest: s.authorRequest + 1 })),
  advanceAfterDrag: () => {
    if (get().state !== 'step1') return;
    writeDemoTips('step2');
    set({ state: 'step2' });
  },
  dismiss: () => {
    // `done` when they had already reached step 2, so restoring later does not
    // re-run a walkthrough they finished; plain `dismissed` otherwise.
    writeDemoTips(get().state === 'step2' ? 'done' : 'dismissed');
    set({ state: 'dismissed' });
  },
  restore: () => {
    writeDemoTips('step1');
    set({ state: 'step1' });
  },
}));
