import type { Task } from '@/types';

export type SortCol = 'wbs' | 'name' | 'start' | 'finish' | 'duration' | 'progress';
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

export function sortTasks(tasks: Task[], col: SortCol, dir: SortDir): Task[] {
  return [...tasks].sort((a, b) => {
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
