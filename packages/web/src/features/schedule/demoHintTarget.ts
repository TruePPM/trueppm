import type { Task } from '@/types';

/**
 * Pick the task the demo's landing hint asks the visitor to drag (#4050 A6).
 *
 * **Why this is derived and not a name.** The design names "Performance
 * tuning", and Part B's seed overlay is what makes that task the one realistic
 * signal left on the landing project — about two days behind plan, on the
 * critical path, with float to absorb it. Hard-coding the string would couple
 * the web bundle to a fixture row: renaming it in the seed, translating it, or
 * pointing the demo at a different sample project would leave the hint naming a
 * task that is not there, and the failure would be a sentence that reads fine
 * and scrolls to nothing. So the hint looks the task up by its **schedule
 * position** — the property the overlay actually creates — and reads its name
 * off whatever it finds.
 *
 * It also means MR A stands on today's unmodified seed: with the Atlas fixture
 * as it ships, this resolves to the in-progress critical task that is furthest
 * behind, which is a sensible thing to drag whether or not Part B has landed.
 *
 * Pure so the ranking is testable without a canvas, a store, or a project.
 */

/** What the hint publishes for the bar to name and the canvas to scroll to. */
export interface DemoHintTarget {
  id: string;
  name: string;
}

/**
 * Expected percent complete for a task at `todayIso`, on a straight-line ramp
 * between its start and finish.
 *
 * Straight-line rather than an S-curve on purpose: this decides which of two
 * dozen rows to *point at*, not what to report. An S-curve would change the
 * ranking only where two tasks are within a few points of each other, and in
 * that case either is a fine thing to drag.
 *
 * Returns `null` for a task with no usable window — a milestone, a zero-length
 * row, or one whose dates are missing — which is also a task nobody can drag
 * two days to any visible effect.
 */
export function expectedProgress(task: Task, todayIso: string): number | null {
  if (task.isMilestone || task.isSummary) return null;
  if (!task.start || !task.finish) return null;
  const start = Date.parse(`${task.start.slice(0, 10)}T00:00:00Z`);
  const finish = Date.parse(`${task.finish.slice(0, 10)}T00:00:00Z`);
  const today = Date.parse(`${todayIso.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(finish) || !Number.isFinite(today)) return null;
  if (finish <= start) return null;
  if (today <= start) return 0;
  if (today >= finish) return 100;
  return ((today - start) / (finish - start)) * 100;
}

/**
 * How far behind its plan a task is, in percentage points. Negative = ahead.
 *
 * `null` when the task has no plan to be behind of (see {@link expectedProgress}).
 */
export function behindByPoints(task: Task, todayIso: string): number | null {
  const expected = expectedProgress(task, todayIso);
  if (expected === null) return null;
  return expected - (task.progress ?? 0);
}

/**
 * The single task the hint names, or `null` when nothing qualifies.
 *
 * Ranking, in order:
 *   1. **On the critical path and behind plan** — the overlay's deliberate
 *      signal, and the only row where a two-day drag visibly moves the project
 *      finish. That last clause is why criticality leads: dragging a task with
 *      float teaches the opposite of what the hint promises ("watch the finish
 *      date move") and would make the product look inert.
 *   2. Critical and started, most-behind first — a plan with nothing behind.
 *   3. Nothing. The bar then says "a task" and offers no scroll: an
 *      empty-but-honest hint, rather than one that points at a row picked
 *      because it happened to be first.
 *
 * Ties break on `id` so the hint is stable across re-renders and across the
 * nightly reset — a hint that names a different task every poll is noise.
 */
export function pickDemoHintTarget(
  tasks: readonly Task[],
  todayIso: string,
): DemoHintTarget | null {
  const candidates = tasks
    .filter((t) => t.isCritical && !t.isSummary && !t.isMilestone)
    .map((t) => ({ task: t, behind: behindByPoints(t, todayIso) }))
    .filter((c): c is { task: Task; behind: number } => c.behind !== null);

  const started = candidates.filter((c) => (c.task.progress ?? 0) > 0 || c.behind > 0);
  const pool = started.length > 0 ? started : [];
  if (pool.length === 0) return null;

  const best = pool.reduce((a, b) => {
    if (b.behind !== a.behind) return b.behind > a.behind ? b : a;
    return b.task.id < a.task.id ? b : a;
  }, pool[0]);
  if (best.behind <= 0) return null;
  return { id: best.task.id, name: best.task.name };
}
