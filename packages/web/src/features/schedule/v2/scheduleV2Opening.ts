import type { Task } from '@/types';
import { isMissingCommittedStart } from '../missingCommittedStart';

/** The grid's fixed opening width in shell v2: ID, task, owner, finish, float. */
export const V2_GRID_WIDTH = 448;
/** Sum of the non-task columns of the v2 default set (wbs 48 + owner 72 + finish 74 + float 56). */
export const V2_FIXED_COLUMNS_WIDTH = 250;
/** The opening window: 12 weeks, starting 16 days before today (#5106). */
export const V2_WINDOW_DAYS = 84;
/**
 * Whole days: `openingWindow` rounds the center date, so a fractional lead would
 * shift the left edge by a day. 16/84 puts the today line at 19% of the width,
 * inside the left fifth.
 */
export const V2_LEAD_DAYS = 16;
/** Children shown under an expanded phase before the "N more" chip (#5106). */
export const V2_CHILD_CAP = 10;

const DAY_MS = 86_400_000;

/** ISO date `days` from `today` (fractional days round to the nearest whole day). */
export function shiftIso(today: string, days: number): string {
  const t = Date.parse(`${today}T00:00:00Z`) + Math.round(days) * DAY_MS;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * The opening viewport: px/day that fits 12 weeks into the timeline, and the
 * date at the viewport's center (the engine centers on a date), so that the
 * left edge lands 16 days before today.
 */
export function openingWindow(
  today: string,
  viewportPx: number,
): { pxPerDay: number; centerIso: string } {
  return {
    pxPerDay: viewportPx / V2_WINDOW_DAYS,
    centerIso: shiftIso(today, -V2_LEAD_DAYS + V2_WINDOW_DAYS / 2),
  };
}

/**
 * Ids to expand on open: the root phase that contains `today` (or, when none
 * does, the first unfinished root phase) and every summary beneath it. Other
 * phases open collapsed so today's work is the thing above the fold.
 */
export function openingExpandedIds(tasks: readonly Task[], today: string): string[] {
  const byParent = new Map<string, Task[]>();
  const roots: Task[] = [];
  const ids = new Set(tasks.map((t) => t.id));
  for (const t of tasks) {
    const parent = t.parentId ?? null;
    if (parent && ids.has(parent)) {
      const list = byParent.get(parent) ?? [];
      list.push(t);
      byParent.set(parent, list);
    } else roots.push(t);
  }
  const phases = roots.filter((t) => t.isSummary);
  if (phases.length === 0) return [];
  const contains = (t: Task) => !!t.start && !!t.finish && t.start <= today && today <= t.finish;
  const current =
    phases.find(contains) ??
    phases.find((t) => (t.progress ?? 0) < 100) ??
    phases[phases.length - 1];
  const out: string[] = [];
  const walk = (t: Task) => {
    if (!t.isSummary) return;
    out.push(t.id);
    for (const c of byParent.get(t.id) ?? []) walk(c);
  };
  walk(current);
  return out;
}

export interface CapResult<T extends { id: string }> {
  rows: T[];
  /** Hidden-child count per capped parent id. */
  hiddenByParent: Map<string, number>;
}

/**
 * Cap each expanded parent's direct children at `cap`, hiding the rest (and
 * their subtrees) until the parent id is in `showAll`. Ids in `exempt` (a
 * selected or jumped-to row and its ancestors) are never hidden. `parentOf` returns a
 * row's parent id. Order is preserved.
 */
export function capChildren<T extends { id: string }>(
  rows: readonly T[],
  parentOf: (row: T) => string | null,
  showAll: ReadonlySet<string>,
  cap = V2_CHILD_CAP,
  exempt: ReadonlySet<string> = new Set(),
): CapResult<T> {
  const seen = new Map<string, number>();
  const hiddenParents = new Set<string>();
  const hiddenByParent = new Map<string, number>();
  const out: T[] = [];
  for (const row of rows) {
    const parent = parentOf(row);
    if (parent && hiddenParents.has(parent)) {
      // Descendant of a hidden row: hidden with it.
      hiddenParents.add(row.id);
      continue;
    }
    if (parent && !showAll.has(parent) && !exempt.has(row.id)) {
      const n = (seen.get(parent) ?? 0) + 1;
      seen.set(parent, n);
      if (n > cap) {
        hiddenParents.add(row.id);
        hiddenByParent.set(parent, (hiddenByParent.get(parent) ?? 0) + 1);
        continue;
      }
    }
    out.push(row);
  }
  return { rows: out, hiddenByParent };
}

export interface GridWarnings {
  total: number;
  noCommittedStart: number;
  blocked: number;
}

/** The numbers the grid footer and the header roll-up print (#5106 "one warning"). */
export function gridWarnings(tasks: readonly Task[]): GridWarnings {
  let noCommittedStart = 0;
  let blocked = 0;
  for (const t of tasks) {
    if (t.isSummary) continue;
    if (isMissingCommittedStart(t)) noCommittedStart += 1;
    if (t.blockedReason) blocked += 1;
  }
  return { total: tasks.filter((t) => !t.isSummary).length, noCommittedStart, blocked };
}

/** "12 tasks · 2 blocked · 3 no committed start" — only non-zero warnings appear. */
export function gridFooterText(w: GridWarnings): string {
  const parts = [`${w.total} ${w.total === 1 ? 'task' : 'tasks'}`];
  if (w.blocked > 0) parts.push(`${w.blocked} blocked`);
  return parts.join(' · ');
}
