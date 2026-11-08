/**
 * Pure model for the phone quick-log sheet's steppers. Kept free of React so the
 * stepping, clamping and entry-building rules are unit-testable on their own.
 */

/** One stepper press moves the value by half an hour (Pass 1 screen `phoneLog`). */
export const STEP_HOURS = 0.5;

/** A single task cannot be logged for more than a day in one quick-log. */
export const MAX_HOURS = 24;

/** Hours per task id; an absent id means 0. */
export type HoursByTask = Record<string, number>;

/** Move `current` one step up (+1) or down (-1), clamped to 0..MAX_HOURS. */
export function stepHours(current: number, direction: 1 | -1): number {
  const next = Math.round((current + direction * STEP_HOURS) / STEP_HOURS) * STEP_HOURS;
  return Math.min(MAX_HOURS, Math.max(0, next));
}

/** `0` → "0h", `1.5` → "1.5h", `2` → "2h". */
export function formatHours(hours: number): string {
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`;
}

/** Screen-reader form: "1.5 hours", "1 hour", "0 hours". */
export function spokenHours(hours: number): string {
  const n = Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
  return `${n} ${hours === 1 ? 'hour' : 'hours'}`;
}

export interface QuickLogEntry {
  taskId: string;
  minutes: number;
}

/** The writes a Save should post: every task with a positive value, in list order. */
export function buildEntries(taskIds: string[], hours: HoursByTask): QuickLogEntry[] {
  return taskIds
    .filter((id) => (hours[id] ?? 0) > 0)
    .map((id) => ({ taskId: id, minutes: Math.round((hours[id] ?? 0) * 60) }));
}
