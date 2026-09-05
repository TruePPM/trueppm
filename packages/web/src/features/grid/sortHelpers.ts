import type { Task } from '@/types';

export type SortCol =
  | 'wbs'
  | 'name'
  | 'start'
  | 'finish'
  | 'duration'
  | 'progress'
  | 'totalFloat'
  | 'freeFloat';
export type SortDir = 'asc' | 'desc';

export function compareWbs(a: string, b: string): number {
  const ap = a.split('.').map(Number);
  const bp = b.split('.').map(Number);
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const diff = (ap[i] ?? 0) - (bp[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * A row whose CPM has not run has no float, and that is not the same as zero
 * (#3344). Sorting float ascending is the "which row is tightest" question, and
 * an unanswered row is not the answer to it in either direction — so nulls sort
 * LAST both ways rather than being folded in as -Infinity/0. That is why this
 * branch computes its own sign instead of falling through to the shared
 * `dir === 'asc' ? cmp : -cmp` at the bottom, which would flip the nulls to the
 * top on a descending sort.
 */
function compareFloat(
  av: number | null | undefined,
  bv: number | null | undefined,
  dir: SortDir,
): number {
  const aMissing = av === null || av === undefined;
  const bMissing = bv === null || bv === undefined;
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;
  return dir === 'asc' ? av - bv : bv - av;
}

export function sortTasks(tasks: Task[], col: SortCol, dir: SortDir): Task[] {
  return [...tasks].sort((a, b) => {
    if (col === 'totalFloat') return compareFloat(a.totalFloat, b.totalFloat, dir);
    if (col === 'freeFloat') return compareFloat(a.freeFloat, b.freeFloat, dir);
    let cmp = 0;
    if (col === 'wbs') cmp = compareWbs(a.wbs, b.wbs);
    else if (col === 'name') cmp = a.name.localeCompare(b.name);
    else if (col === 'start') cmp = a.start.localeCompare(b.start);
    else if (col === 'finish') cmp = a.finish.localeCompare(b.finish);
    else if (col === 'duration') cmp = a.duration - b.duration;
    else if (col === 'progress') cmp = a.progress - b.progress;
    return dir === 'asc' ? cmp : -cmp;
  });
}
