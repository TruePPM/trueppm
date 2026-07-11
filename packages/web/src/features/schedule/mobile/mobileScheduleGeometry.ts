import type { Task } from '@/types';

/**
 * Pure geometry helpers for the mobile Schedule list-timeline (#1671, ADR-0348).
 *
 * The mobile surface places every task bar against ONE shared project-window
 * scale (not a per-row scale) so the rows read as a left-to-right cascade you
 * can eyeball for sequence and gaps. Kept as pure functions so the placement
 * math is unit-testable without rendering the canvas-free DOM list.
 */

/** The min→max date envelope of the scheduled tasks, in epoch ms. */
export interface ScheduleWindow {
  startMs: number;
  endMs: number;
  spanMs: number;
}

/** A bar's horizontal placement as percentages of the shared window. */
export interface BarGeometry {
  leftPct: number;
  widthPct: number;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

/**
 * Compare two WBS display codes ("1.2" vs "1.10") segment-by-segment as
 * numbers, so "1.10" sorts after "1.2" (string sort would invert them).
 */
export function compareWbs(a: string, b: string): number {
  const pa = (a || '').split('.');
  const pb = (b || '').split('.');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = Number(pa[i] ?? 0);
    const y = Number(pb[i] ?? 0);
    if (x !== y) return x - y;
  }
  return 0;
}

/** Outline depth from a WBS code ("1.2.3" → 2), capped so a deep tree never
 *  eats the whole row width on a 375px phone. */
export function wbsDepth(wbs: string, cap = 4): number {
  const segments = (wbs || '').split('.').length - 1;
  return Math.min(Math.max(segments, 0), cap);
}

/**
 * The shared window spanning all dated tasks. Returns null when no task has a
 * parseable start+finish (the "not scheduled yet" state) so the caller can
 * branch instead of dividing by zero.
 */
export function computeScheduleWindow(tasks: Task[]): ScheduleWindow | null {
  let startMs = Infinity;
  let endMs = -Infinity;
  for (const t of tasks) {
    const s = Date.parse(t.start);
    const f = Date.parse(t.finish);
    if (!Number.isNaN(s)) startMs = Math.min(startMs, s);
    if (!Number.isNaN(f)) endMs = Math.max(endMs, f);
  }
  if (startMs === Infinity || endMs === -Infinity) return null;
  return { startMs, endMs, spanMs: endMs - startMs };
}

/**
 * A task bar's left/width as percentages of the shared window. A zero-span
 * window (every task on one day) renders full-width bars; a 0.75% floor keeps
 * a one-day task on a six-month window a visible sliver rather than nothing.
 */
export function barGeometry(task: Task, window: ScheduleWindow | null): BarGeometry {
  if (!window || window.spanMs <= 0) return { leftPct: 0, widthPct: 100 };
  const s = Date.parse(task.start);
  const f = Date.parse(task.finish);
  if (Number.isNaN(s) || Number.isNaN(f)) return { leftPct: 0, widthPct: 100 };
  const leftPct = clamp(((s - window.startMs) / window.spanMs) * 100, 0, 100);
  const rawWidth = ((f - s) / window.spanMs) * 100;
  const widthPct = clamp(rawWidth, 0.75, 100 - leftPct);
  return { leftPct, widthPct };
}

/** A milestone/point marker's left position (uses start, falling back to
 *  finish for a zero-duration task). Null when it falls outside the window. */
export function markerLeftPct(task: Task, window: ScheduleWindow | null): number {
  if (!window || window.spanMs <= 0) return 0;
  const at = Date.parse(task.start) || Date.parse(task.finish);
  if (Number.isNaN(at)) return 0;
  return clamp(((at - window.startMs) / window.spanMs) * 100, 0, 100);
}

/**
 * Today's position within the window, or null when today is outside it (so the
 * caller omits the marker rather than pinning it to an edge). `todayMs` is
 * injected for deterministic tests.
 */
export function todayLeftPct(window: ScheduleWindow | null, todayMs: number): number | null {
  if (!window || window.spanMs <= 0) return null;
  if (todayMs < window.startMs || todayMs > window.endMs) return null;
  return ((todayMs - window.startMs) / window.spanMs) * 100;
}
