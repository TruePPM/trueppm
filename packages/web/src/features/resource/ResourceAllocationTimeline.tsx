/**
 * Resource allocation timeline view (issue #85, ADR-0031).
 *
 * DOM-based timeline: each resource is a row; assigned tasks are absolutely-
 * positioned spans whose left/width are derived from the window geometry.
 * Rows are rendered as plain DOM (virtual scroll not needed at ≤50 resources).
 *
 * Overallocation is computed client-side via detectOverallocatedAssignments().
 * Calendar-aware non-working-day exclusion is deferred to a follow-up issue.
 */
import { useRef, useState } from 'react';
import type { AllocationResource, AllocationResponse } from './resourceUtils';
import {
  parseUTCDate,
  todayISO,
  detectOverallocatedAssignments,
  groupByWeek,
  dateRange,
  MONTH_ABBR,
} from './resourceUtils';
import { AllocationSpan, type SpanVariant } from './AllocationSpan';
import { AllocationEditPopover } from './AllocationEditPopover';
import type { AllocationTask } from './resourceUtils';

interface Props {
  data: AllocationResponse;
  windowStart: string;
  windowEnd: string;
  /** Current user's resource ID — used to highlight "My allocation" row */
  currentUserResourceId?: string;
  projectId: string | undefined;
}

interface ActiveEdit {
  assignmentId: string;
  task: AllocationTask;
  resourceName: string;
  maxUnits: number;
  /** Row element ref for positioning the popover */
  anchorEl: HTMLElement;
}

// ---------------------------------------------------------------------------
// Time axis helpers
// ---------------------------------------------------------------------------

function buildMonthGroups(
  windowStart: string,
  windowEnd: string,
): Array<{ label: string; colSpan: number }> {
  const days = dateRange(windowStart, windowEnd);
  const groups: Array<{ label: string; colSpan: number }> = [];
  for (const iso of days) {
    const d = parseUTCDate(iso);
    const label = `${MONTH_ABBR[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    if (groups.length && groups[groups.length - 1].label === label) {
      groups[groups.length - 1].colSpan++;
    } else {
      groups.push({ label, colSpan: 1 });
    }
  }
  return groups;
}

function buildWeekColumns(
  windowStart: string,
  windowEnd: string,
): Array<{ label: string; colSpan: number }> {
  const weeks = groupByWeek(dateRange(windowStart, windowEnd));
  return weeks.map((w) => ({
    label: `W${getISOWeekNumber(parseUTCDate(w.weekStart))}`,
    colSpan: w.days.length,
  }));
}

function getISOWeekNumber(d: Date): number {
  const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const startOfWeek1 = new Date(jan4.getTime() - ((jan4.getUTCDay() || 7) - 1) * 86400000);
  return Math.floor((d.getTime() - startOfWeek1.getTime()) / (7 * 86400000)) + 1;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function spanFractions(
  taskStart: string,
  taskEnd: string,
  windowStart: string,
  windowEnd: string,
): { left: number; width: number } {
  const ws = parseUTCDate(windowStart).getTime();
  const we = parseUTCDate(windowEnd).getTime() + 86_400_000; // exclusive end
  const total = we - ws;
  const ts = Math.max(parseUTCDate(taskStart).getTime(), ws);
  const te = Math.min(parseUTCDate(taskEnd).getTime() + 86_400_000, we);
  return {
    left: (ts - ws) / total,
    width: Math.max(0, (te - ts) / total),
  };
}

// ---------------------------------------------------------------------------
// ResourceAllocationTimeline
// ---------------------------------------------------------------------------

export function ResourceAllocationTimeline({
  data,
  windowStart,
  windowEnd,
  currentUserResourceId,
  projectId,
}: Props) {
  const timelineRef = useRef<HTMLDivElement>(null);
  const [activeEdit, setActiveEdit] = useState<ActiveEdit | null>(null);
  const today = todayISO();

  const totalDays = dateRange(windowStart, windowEnd).length;
  const todayFraction = (() => {
    const ws = parseUTCDate(windowStart).getTime();
    const we = parseUTCDate(windowEnd).getTime() + 86_400_000;
    const td = parseUTCDate(today).getTime();
    if (td < ws || td > we) return null;
    return (td - ws) / (we - ws);
  })();

  const monthGroups = buildMonthGroups(windowStart, windowEnd);
  const weekColumns = buildWeekColumns(windowStart, windowEnd);

  const scheduled = data.resources.filter((r) => r.tasks.some((t) => t.early_start));
  const unscheduled = data.resources.flatMap((r) =>
    r.tasks
      .filter((t) => !t.early_start)
      .map((t) => ({ resource: r, task: t })),
  );

  function openEdit(assignmentId: string, anchorEl: HTMLElement) {
    // Find the task + resource for this assignmentId
    for (const resource of data.resources) {
      for (const task of resource.tasks) {
        if (task.assignment_id === assignmentId) {
          setActiveEdit({
            assignmentId,
            task,
            resourceName: resource.name,
            maxUnits: parseFloat(resource.max_units),
            anchorEl,
          });
          return;
        }
      }
    }
  }

  function closeEdit() {
    setActiveEdit(null);
  }

  function handleSaved(_assignmentId: string, _newUnits: number) {
    // Optimistic update happens via query invalidation in AllocationEditPopover.
    // Nothing extra needed here.
  }

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------

  function renderResourceRow(resource: AllocationResource) {
    const maxUnits = parseFloat(resource.max_units);
    const overloaded = detectOverallocatedAssignments(resource.tasks, maxUnits);
    const isCurrentUser = resource.id === currentUserResourceId;
    const hasOverallocation = overloaded.size > 0;
    const availDisplay = `${Math.round(maxUnits * 100)}% available`;

    return (
      <div
        key={resource.id}
        className={[
          'flex border-b border-neutral-border',
          hasOverallocation ? 'bg-semantic-critical/5' : '',
          isCurrentUser ? 'bg-brand-primary/5' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        style={{ minHeight: '44px' }}
      >
        {/* Row header */}
        <div
          className="flex-shrink-0 w-48 border-r border-neutral-border px-3 py-2 flex flex-col justify-center gap-0.5"
          style={{ minWidth: '12rem' }}
        >
          <div className="flex items-center gap-1 min-w-0">
            <span className="text-[13px] font-medium text-neutral-text-primary truncate">
              {resource.name}
            </span>
            {isCurrentUser && (
              <span className="text-[9px] font-bold px-1 rounded bg-brand-primary/10 text-brand-primary flex-shrink-0">
                you
              </span>
            )}
          </div>
          <div
            className={[
              'text-[11px] flex items-center gap-1',
              hasOverallocation ? 'text-semantic-critical' : 'text-neutral-text-secondary',
            ].join(' ')}
          >
            {hasOverallocation && (
              <button
                type="button"
                className="w-2 h-2 rounded-full bg-semantic-critical flex-shrink-0 focus-visible:ring-1 focus-visible:ring-semantic-critical focus-visible:outline-none"
                aria-label={`Jump to first overallocation for ${resource.name}`}
                title={`Jump to first overallocation for ${resource.name}`}
                onClick={() => {
                  // Scroll the first overallocated span into view
                  const el = timelineRef.current?.querySelector(
                    `[data-assignment-id="${[...overloaded][0]}"]`,
                  );
                  el?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
                }}
              />
            )}
            {availDisplay}
          </div>
        </div>

        {/* Timeline track */}
        <div
          className="flex-1 relative overflow-hidden"
          style={{ backgroundImage: 'var(--tl-grid-bg)', backgroundSize: `${100 / totalDays}% 100%` }}
        >
          {/* Today line */}
          {todayFraction !== null && (
            <div
              aria-hidden="true"
              className="absolute top-0 bottom-0 w-0.5 bg-brand-primary/50 z-10 pointer-events-none"
              style={{ left: `${todayFraction * 100}%` }}
            />
          )}

          {/* Task spans */}
          {resource.tasks
            .filter((t) => t.early_start && t.early_finish)
            .map((task) => {
              const isOver = overloaded.has(task.assignment_id);
              const units = parseFloat(task.units);
              const variant: SpanVariant =
                task.status === 'COMPLETE'
                  ? 'complete'
                  : isOver
                  ? 'over'
                  : units < 1.0
                  ? 'partial'
                  : 'normal';

              const { left, width } = spanFractions(
                task.early_start!,
                task.early_finish!,
                windowStart,
                windowEnd,
              );

              return (
                <div
                  key={task.assignment_id}
                  data-assignment-id={task.assignment_id}
                  className="absolute inset-y-0"
                  style={{ left: `${left * 100}%`, width: `${width * 100}%` }}
                >
                  <AllocationSpan
                    task={task}
                    variant={variant}
                    leftFraction={0}
                    widthFraction={1}
                    containerWidth={timelineRef.current?.getBoundingClientRect().width ?? 600}
                    onEdit={(id) => {
                      const el = document.querySelector<HTMLElement>(
                        `[data-assignment-id="${id}"]`,
                      );
                      if (el) openEdit(id, el);
                    }}
                  />

                  {/* Popover for this span */}
                  {activeEdit?.assignmentId === task.assignment_id && (
                    <AllocationEditPopover
                      assignmentId={activeEdit.assignmentId}
                      task={activeEdit.task}
                      resourceName={activeEdit.resourceName}
                      maxUnits={activeEdit.maxUnits}
                      onClose={closeEdit}
                      onSaved={handleSaved}
                      projectId={projectId}
                    />
                  )}
                </div>
              );
            })}
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="flex flex-col h-full overflow-hidden" ref={timelineRef}>

      {/* Sticky axis header */}
      <div className="flex flex-shrink-0 border-b border-neutral-border bg-neutral-surface-raised sticky top-0 z-10">
        {/* Column header label */}
        <div className="flex-shrink-0 w-48 border-r border-neutral-border px-3 py-1.5 flex items-end">
          <span className="text-[10px] uppercase tracking-wide text-neutral-text-secondary">
            Resource
          </span>
        </div>

        {/* Month + week axis */}
        <div className="flex-1 overflow-hidden">
          {/* Month row */}
          <div className="flex text-[10px] font-semibold text-neutral-text-secondary">
            {monthGroups.map((m, i) => (
              <div
                key={i}
                className="border-r border-neutral-border px-1 py-0.5 truncate"
                style={{ flex: m.colSpan }}
              >
                {m.label}
              </div>
            ))}
          </div>
          {/* Week row */}
          <div className="flex text-[10px] text-neutral-text-secondary">
            {weekColumns.map((w, i) => (
              <div
                key={i}
                className="border-r border-neutral-border px-1 pb-0.5 truncate"
                style={{ flex: w.colSpan }}
              >
                {w.label}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Resource rows */}
      <div className="flex-1 overflow-y-auto">
        {scheduled.map((resource) => renderResourceRow(resource))}

        {/* Unscheduled section */}
        {unscheduled.length > 0 && (
          <div className="border-t-2 border-semantic-at-risk/30 bg-semantic-at-risk/5">
            <div className="flex items-center gap-2 px-4 py-2 text-xs text-semantic-at-risk border-b border-semantic-at-risk/20">
              <span>⚠</span>
              <span className="font-medium">
                {unscheduled.length} unscheduled assignment
                {unscheduled.length !== 1 ? 's' : ''} — tasks with no computed dates.
              </span>
              <span className="text-neutral-text-secondary">Run the scheduler to place them on the timeline.</span>
            </div>
            {unscheduled.map(({ resource, task }) => (
              <div
                key={task.assignment_id}
                className="flex items-center gap-2 px-4 py-1.5 text-xs text-neutral-text-secondary border-b border-neutral-border/50"
              >
                <span className="w-2 h-2 rounded-full bg-neutral-border flex-shrink-0" />
                <span className="font-medium text-neutral-text-primary">{resource.name}</span>
                <span className="text-neutral-text-secondary">→</span>
                <span className="font-medium">{task.name}</span>
                <span className="text-neutral-text-secondary">
                  ({Math.round(parseFloat(task.units) * 100)}%)
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Screen-reader summary */}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {`Resource allocation timeline. ${scheduled.length} resources. `}
        {scheduled.filter((r) => {
          const over = detectOverallocatedAssignments(r.tasks, parseFloat(r.max_units));
          return over.size > 0;
        }).length > 0 &&
          `${scheduled.filter((r) => {
            const over = detectOverallocatedAssignments(r.tasks, parseFloat(r.max_units));
            return over.size > 0;
          }).length} overallocated. `}
        {`Date range ${windowStart} to ${windowEnd}.`}
      </div>
    </div>
  );
}
