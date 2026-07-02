/**
 * Work-item type micro-pill (#731) — surfaces the story/task/bug/spike taxonomy
 * on a backlog row and in the drawer header, so epic→story structure is no longer
 * implicit in WBS nesting alone. Epics render as their own `EpicHeader` row, so
 * this badge primarily distinguishes a Story from the other non-epic types that
 * can appear in the ungrouped section.
 *
 * Always neutral tokens: the *word* carries the meaning (rule 12), never colour —
 * a red "BUG" pill would collide with the at-risk/critical semantics (rules
 * 145/146). Matches the adjacent DorChip's `text-xs` weight (atoms.tsx).
 */

import type { TaskType } from '@/types';

const LABEL: Record<TaskType, string> = {
  epic: 'Epic',
  story: 'Story',
  task: 'Task',
  bug: 'Bug',
  spike: 'Spike',
  tech_debt: 'Tech Debt',
};

export function TypeBadge({ type }: { type?: TaskType }) {
  // Legacy/non-agile rows have no type → treat as a plain task.
  const t: TaskType = type ?? 'task';
  return (
    <span className="inline-block shrink-0 whitespace-nowrap rounded-chip border border-neutral-border bg-neutral-surface-sunken px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-neutral-text-secondary">
      {LABEL[t]}
    </span>
  );
}
