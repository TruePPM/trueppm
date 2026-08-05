import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Task } from '@/types';
import { isTaskScheduled } from '@/lib/task';
import { useIterationLabel } from '@/hooks/useIterationLabel';

const COLLAPSED_KEY = 'trueppm.backlog.notInSprintStrip.collapsed';

interface NotInSprintStripProps {
  /** Every story currently in the backlog (epic-grouped + ungrouped), flat. */
  stories: Task[];
  /** Opens the story's detail drawer — same affordance every other row uses. */
  onSelect: (storyId: string) => void;
}

/**
 * Collapsible summary of backlog stories with no sprint commitment (#2734,
 * ADR-0800) — the agile re-labeling of the waterfall Unscheduled gutter
 * (`features/schedule/UnscheduledGutter.tsx`). Deliberately reuses the same
 * "scheduled" predicate (`isTaskScheduled`, `@/lib/task.ts` — `plannedStart != null
 * || sprintId != null`) rather than inventing a parallel one, so "unscheduled" and
 * "not in a sprint" are provably the same concept surfaced on two views, not two
 * concepts that happen to look similar today and can drift apart tomorrow.
 *
 * Read-only: unlike the Gantt gutter, there is no drag target here yet (dragging a
 * story into a sprint needs a sprint to exist — sprint cadence generation is E3,
 * explicitly out of this issue's scope). Clicking a row opens its detail drawer,
 * where the sprint-commitment control already lives (`SprintCommitButton`).
 *
 * Copy is driven by `useIterationLabel()`, never the literal word "sprint" — this
 * file sits under `src/features/project/backlog/**`, which the iteration-label
 * eslint gate (`no-restricted-syntax`, #1287) covers, and the "Not in a sprint"
 * wording from the issue is adapted to the project's configured term the same way
 * ADR-0203 renamed the SPRINT nav group to DELIVER for HYBRID projects.
 */
export function NotInSprintStrip({ stories, onSelect }: NotInSprintStripProps) {
  const itl = useIterationLabel();

  const unassigned = useMemo(() => stories.filter((s) => !isTaskScheduled(s)), [stories]);
  const unestimatedCount = useMemo(
    () => unassigned.filter((s) => s.storyPoints == null).length,
    [unassigned],
  );

  // Absent a persisted choice, default to collapsed when there is nothing to show —
  // mirrors UnscheduledGutter's default so an otherwise fully-committed backlog
  // doesn't carry permanent empty chrome.
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(COLLAPSED_KEY);
      return stored !== null ? stored === 'true' : unassigned.length === 0;
    } catch {
      return unassigned.length === 0;
    }
  });

  const prevCountRef = useRef(unassigned.length);
  useEffect(() => {
    if (unassigned.length > 0 && prevCountRef.current === 0) {
      setCollapsed(false);
    }
    prevCountRef.current = unassigned.length;
  }, [unassigned.length]);

  const persistCollapsed = useCallback((val: boolean) => {
    setCollapsed(val);
    try {
      localStorage.setItem(COLLAPSED_KEY, String(val));
    } catch {
      /* ignore — collapse state is a convenience, not a durable preference */
    }
  }, []);

  const label = `Not ${itl.lower}-assigned`;

  return (
    <div
      role="region"
      aria-label={label}
      className="mt-3.5 flex-shrink-0 rounded-card border border-neutral-border bg-neutral-surface-sunken"
    >
      <div className="flex h-11 items-center px-4">
        <span className="text-xs font-semibold uppercase tracking-widest text-neutral-text-secondary">
          {label}
        </span>
        <span className="tppm-mono ml-1 text-xs text-neutral-text-secondary">
          ({unassigned.length})
        </span>
        {unassigned.length > 0 && (
          <span className="ml-3 text-xs text-neutral-text-secondary">
            {unestimatedCount} unestimated
          </span>
        )}
        {unassigned.length === 0 && !collapsed && (
          <span className="ml-3 text-xs italic text-neutral-text-secondary">
            Every story carries a {itl.lower}
          </span>
        )}
        <div className="flex-1" />
        <button
          type="button"
          aria-label={collapsed ? `Expand ${label}` : `Collapse ${label}`}
          onClick={() => persistCollapsed(!collapsed)}
          className="flex h-8 w-8 items-center justify-center rounded-control text-neutral-text-secondary
            hover:text-neutral-text-primary
            focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
        >
          <span
            className={`inline-block transition-transform duration-150 ${collapsed ? '' : 'rotate-180'}`}
            aria-hidden="true"
          >
            ▾
          </span>
        </button>
      </div>

      {!collapsed && unassigned.length > 0 && (
        <ul className="max-h-[240px] overflow-y-auto border-t border-neutral-border">
          {unassigned.map((story) => (
            <li key={story.id}>
              <button
                type="button"
                onClick={() => onSelect(story.id)}
                className="flex w-full items-center gap-2.5 px-4 py-1.5 text-left text-[13px] text-neutral-text-primary
                  hover:bg-neutral-surface-raised
                  focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-inset"
              >
                <span className="flex-1 truncate">{story.name}</span>
                <span className="tppm-mono shrink-0 text-xs text-neutral-text-secondary">
                  {story.storyPoints == null ? 'unestimated' : `${story.storyPoints} pts`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
