import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { TaskStatus } from '@/types';
import type { SprintBacklogTask } from '@/hooks/useSprintBacklog';

/** Approximate popover width — kept in sync with `w-72` (288px) below. */
const POPOVER_WIDTH = 288;
/** Vertical gap between the anchor button and the popover. */
const POPOVER_GAP = 8;
/** Minimum margin from the viewport's left edge so the popover never clips. */
const VIEWPORT_MARGIN = 8;

/**
 * 'me' selects tasks assigned to the current user; 'anyone' clears the filter;
 * any other string is treated as a Resource id.
 */
export type SprintFilterAssignee = 'me' | 'anyone' | (string & {});

export interface SprintFilterValue {
  assignee: SprintFilterAssignee;
  /** Empty Set means "all statuses" (no filter). */
  statuses: Set<TaskStatus>;
}

const STATUS_CHIPS: ReadonlyArray<{ status: TaskStatus; label: string; tone: string }> = [
  { status: 'BACKLOG', label: 'Backlog', tone: 'neutral' },
  { status: 'NOT_STARTED', label: 'Not Started', tone: 'neutral' },
  { status: 'IN_PROGRESS', label: 'In Progress', tone: 'on-track' },
  { status: 'REVIEW', label: 'In Review', tone: 'at-risk' },
  { status: 'COMPLETE', label: 'Done', tone: 'on-track' },
];

interface Props {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  value: SprintFilterValue;
  onChange: (next: SprintFilterValue) => void;
  /** Backlog rows currently in scope — used to derive the assignee picker
   *  options without a separate fetch. */
  tasks: SprintBacklogTask[];
  onClose: () => void;
}

/**
 * Sprint filter popover (issue #299).
 *
 * Anchored under the Filter button on the Sprint header. Filters the Sprint
 * Backlog table (not the metrics row) by assignee and status. State is
 * persisted per-sprint in sessionStorage by the caller; this component is a
 * controlled view over `value` + `onChange`.
 */
export function SprintFilterPopover({ open, anchorRef, value, onChange, tasks, onClose }: Props) {
  const popoverRef = useRef<HTMLDivElement>(null);
  // Fixed-position coordinates derived from the anchor button so the popover
  // hugs the Filter button regardless of the surrounding flex layout — fixes
  // the off-screen render when the parent container extends past the viewport.
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      // Right-align the popover under the button, then clamp to the viewport
      // so it never spills past the left or right edge.
      let left = rect.right - POPOVER_WIDTH;
      const maxLeft = window.innerWidth - POPOVER_WIDTH - VIEWPORT_MARGIN;
      left = Math.max(VIEWPORT_MARGIN, Math.min(left, maxLeft));
      setPos({ top: rect.bottom + POPOVER_GAP, left });
    }
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, anchorRef]);

  // Close on Escape and on outside-click.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    function onPointer(e: MouseEvent) {
      const target = e.target as Node;
      if (popoverRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    }
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onPointer);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onPointer);
    };
  }, [open, onClose, anchorRef]);

  const assigneeOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const t of tasks) {
      for (const a of t.assignments) {
        if (!seen.has(a.resource_id)) seen.set(a.resource_id, a.resource_name);
      }
    }
    return Array.from(seen, ([id, name]) => ({ id, name })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }, [tasks]);

  if (!open) return null;

  function setAssignee(next: SprintFilterValue['assignee']) {
    onChange({ ...value, assignee: next });
  }

  function toggleStatus(status: TaskStatus) {
    const next = new Set(value.statuses);
    if (next.has(status)) next.delete(status);
    else next.add(status);
    onChange({ ...value, statuses: next });
  }

  function reset() {
    onChange({ assignee: 'anyone', statuses: new Set() });
  }

  return (
    <div
      ref={popoverRef}
      role="dialog"
      aria-label="Filter sprint backlog"
      style={pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden' }}
      className="fixed z-30 w-72 rounded-md border border-neutral-border bg-neutral-surface
        text-neutral-text-primary text-xs"
    >
      <div className="flex flex-col gap-3 p-3">
        <fieldset className="flex flex-col gap-1.5">
          <legend className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary">
            Assignee
          </legend>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name="sprint-filter-assignee"
              checked={value.assignee === 'me'}
              onChange={() => setAssignee('me')}
              className="accent-brand-primary"
            />
            Me
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name="sprint-filter-assignee"
              checked={value.assignee === 'anyone'}
              onChange={() => setAssignee('anyone')}
              className="accent-brand-primary"
            />
            Anyone
          </label>
          {assigneeOptions.length > 0 && (
            <div className="border-t border-neutral-border my-1" aria-hidden="true" />
          )}
          {assigneeOptions.map((opt) => (
            <label key={opt.id} className="flex items-center gap-2 cursor-pointer truncate">
              <input
                type="radio"
                name="sprint-filter-assignee"
                checked={value.assignee === opt.id}
                onChange={() => setAssignee(opt.id)}
                className="accent-brand-primary"
              />
              <span className="truncate">{opt.name}</span>
            </label>
          ))}
        </fieldset>

        <fieldset className="flex flex-col gap-1.5">
          <legend className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary">
            Status
          </legend>
          <div className="flex flex-wrap gap-1">
            {STATUS_CHIPS.map((chip) => {
              const active = value.statuses.has(chip.status);
              return (
                <button
                  key={chip.status}
                  type="button"
                  onClick={() => toggleStatus(chip.status)}
                  aria-pressed={active}
                  className={[
                    'border rounded px-2 py-0.5 text-xs',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
                    active
                      ? 'bg-brand-primary/10 border-brand-primary/40 text-brand-primary-dark dark:text-brand-primary'
                      : 'border-neutral-border text-neutral-text-secondary hover:bg-neutral-surface-raised',
                  ].join(' ')}
                >
                  {chip.label}
                </button>
              );
            })}
          </div>
        </fieldset>

        <div className="flex items-center justify-between pt-1 border-t border-neutral-border">
          <button
            type="button"
            onClick={reset}
            className="text-xs underline text-neutral-text-secondary hover:text-neutral-text-primary
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded"
          >
            Reset
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close filter popover"
            className="h-7 px-3 rounded text-xs font-medium border border-brand-primary/40
              text-brand-primary-dark dark:text-brand-primary hover:bg-brand-primary/10
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Apply a `SprintFilterValue` to a list of backlog tasks. Pure — exported
 * so the filter can be reused in tests and elsewhere without rendering the
 * popover.
 */
export function applySprintFilter(
  tasks: SprintBacklogTask[],
  filter: SprintFilterValue,
  myResourceId: string | null,
): SprintBacklogTask[] {
  const wantsAssignee = filter.assignee !== 'anyone';
  const wantsStatuses = filter.statuses.size > 0;
  if (!wantsAssignee && !wantsStatuses) return tasks;
  return tasks.filter((t) => {
    if (wantsStatuses && !filter.statuses.has(t.status)) return false;
    if (wantsAssignee) {
      const target = filter.assignee === 'me' ? myResourceId : filter.assignee;
      if (!target) return false;
      if (!t.assignments.some((a) => a.resource_id === target)) return false;
    }
    return true;
  });
}
