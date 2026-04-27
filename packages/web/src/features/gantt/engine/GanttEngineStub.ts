/**
 * No-op stub implementation of GanttEngine.
 *
 * Two purposes:
 *
 * 1. **Compile-time verification** — if GanttEngine gains a new required
 *    method, this file will fail to compile, surfacing the gap immediately.
 *    Do not add `// @ts-ignore` or make any method optional here.
 *
 * 2. **Test double** — components that accept a `GanttEngine | null` prop
 *    can be rendered in unit tests with `new GanttEngineStub()` instead of
 *    a real canvas implementation. All events no-op; scales return null.
 *
 * Not used in production code — only imported in test files and Storybook.
 */

import type { Task, TaskLink } from '@/types';
import type { GanttEngine, GanttEngineEventMap } from './GanttEngine';
import type { GanttScaleData, ZoomLevel } from './GanttScaleData';

export class GanttEngineStub implements GanttEngine {
  // ── Data ──────────────────────────────────────────────────────────────────

  setTasks(_tasks: Task[]): void {}

  setLinks(_links: TaskLink[]): void {}

  updateTask(_taskId: string, _patch: Partial<Task>): void {}

  // ── Coordinate system ─────────────────────────────────────────────────────

  readonly scales: GanttScaleData | null = null;

  // ── Viewport ──────────────────────────────────────────────────────────────

  readonly scrollLeft: number = 0;

  setZoom(_level: ZoomLevel): void {}

  scrollToDate(_isoDate: string, _behavior?: ScrollBehavior): void {}

  // ── Selection ─────────────────────────────────────────────────────────────

  selectTask(_taskId: string | null): void {}

  selectTasks(_taskIds: string[]): void {}

  readonly selectedTaskIds: ReadonlySet<string> = new Set();

  // ── Event emitter ─────────────────────────────────────────────────────────

  on<K extends keyof GanttEngineEventMap>(
    _event: K,
    _handler: (payload: GanttEngineEventMap[K]) => void,
  ): () => void {
    // Return a no-op unsubscribe so callers never have to null-check
    return () => {};
  }

  // ── Color mode ────────────────────────────────────────────────────────────

  setDark(_dark: boolean): void {}

  // ── Imperative drag control ───────────────────────────────────────────────

  cancelDrag(): void {}

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  destroy(): void {}
}
