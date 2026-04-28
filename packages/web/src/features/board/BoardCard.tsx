import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { useDraggable } from '@dnd-kit/core';
import type { Task, TaskReadiness, TaskStatus } from '@/types';
import { BoardProgressRing } from './BoardProgressRing';
import { formatShortDate } from '@/features/gantt/ganttUtils';

export type BoardDensity = 'compact' | 'comfortable' | 'detailed';

interface BoardCardProps {
  task: Task;
  isOverlay?: boolean;
  isStalled?: boolean;
  onMenuMove: (newStatus: TaskStatus) => void;
  columns: { status: TaskStatus; label: string; slaDays?: number }[];
  density?: BoardDensity;
}

/**
 * Get initials from a full name — at most two chars.
 */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0 || parts[0] === '') return '?';
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Format an entry-stamp line and compute dwell time.
 * Returns daysAgo for use by the SLA aging indicator (issue #192).
 */
function entryStamp(task: Task): { text: string; isStalled: boolean; daysAgo: number | null } {
  if (!task.statusEnteredAt) {
    return { text: '', isStalled: false, daysAgo: null };
  }

  const now = Date.now();
  const enteredMs = new Date(task.statusEnteredAt).getTime();
  const daysAgo = Math.floor((now - enteredMs) / 86_400_000);
  const daysLabel = daysAgo === 1 ? '1d ago' : `${daysAgo}d ago`;

  // Stalled = same status for > 3 days without reaching 100 %
  const isStalled = daysAgo > 3 && task.progress < 100;

  return {
    text: `Entered at ${task.progress}% · ${daysLabel}${isStalled ? ' — stalled' : ''}`,
    isStalled,
    daysAgo,
  };
}

// Readiness chip — top-left pill on each board card (issue #179).
function ReadinessChip({ readiness }: { readiness: TaskReadiness }) {
  switch (readiness) {
    case 'idea':
      return (
        <span className="inline-flex items-center px-1.5 py-px rounded border border-dashed border-neutral-border text-xs text-neutral-text-disabled">
          idea
        </span>
      );
    case 'estimated':
      return (
        <span className="inline-flex items-center gap-0.5 px-1.5 py-px rounded bg-neutral-surface-sunken border border-neutral-border text-xs text-neutral-text-secondary">
          <span aria-hidden="true">·</span> estimated
        </span>
      );
    case 'ready':
      return (
        <span className="inline-flex items-center gap-0.5 px-1.5 py-px rounded bg-brand-primary/10 dark:bg-semantic-on-track/10 border border-brand-primary/30 dark:border-semantic-on-track/30 text-xs text-brand-primary dark:text-semantic-on-track font-medium">
          <span aria-hidden="true">⛓</span> ready
        </span>
      );
    case 'baselined':
      return (
        <span className="inline-flex items-center gap-0.5 px-1.5 py-px rounded bg-neutral-surface-sunken border border-neutral-border text-xs text-neutral-text-secondary font-medium">
          <span aria-hidden="true">🔒</span> baselined
        </span>
      );
  }
}

// Left accent bar color per readiness state (issue #179).
// CP (critical) overrides all; at-risk overrides estimated/ready/baselined.
function accentBarClass(task: Task): string {
  if (task.isCritical) return 'bg-semantic-critical';
  const r = task.readiness ?? 'estimated';
  switch (r) {
    case 'idea':      return 'bg-transparent';
    case 'baselined': return 'bg-semantic-on-track';
    default:          return 'bg-brand-primary';
  }
}

/** Tooltip text for a critical-path task (issue #181 / WCAG 1.4.1). */
function cpTooltip(_task: Task): string {
  return 'On critical path — any delay here will delay the project end date';
}

export function BoardCard({ task, isOverlay, isStalled: isOverrideStalled, onMenuMove, columns, density = 'comfortable' }: BoardCardProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.id,
  });

  const [menuOpen, setMenuOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Remember the real card's rendered height so the drag placeholder matches
  // it (rule 102: placeholder of equal height).  Updated on every non-drag
  // render so varying card content — CP pill, assignees, entry stamp, nudge —
  // produces an equal-height slot.
  const cardElRef = useRef<HTMLDivElement | null>(null);
  const lastHeightRef = useRef<number>(0);
  const measureCardRef = useCallback(
    (node: HTMLDivElement | null) => {
      cardElRef.current = node;
      setNodeRef(node);
    },
    [setNodeRef],
  );
  useLayoutEffect(() => {
    if (isDragging) return;
    const h = cardElRef.current?.offsetHeight;
    if (h && h > 0) lastHeightRef.current = h;
  });

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
        setMoveOpen(false);
      }
    }
    document.addEventListener('pointerdown', handleClick);
    return () => document.removeEventListener('pointerdown', handleClick);
  }, [menuOpen]);

  const otherColumns = columns.filter((c) => c.status !== task.status);
  const { text: stampText, isStalled: derivedStalled, daysAgo } = entryStamp(task);
  const isStalled = isOverrideStalled ?? derivedStalled;

  // Aging / dwell-time indicator (issue #192)
  const slaDays = columns.find((c) => c.status === task.status)?.slaDays;
  const isAging = daysAgo !== null && slaDays !== undefined && daysAgo > slaDays;
  const isPastTwiceSla = isAging && daysAgo > 2 * slaDays;
  const isIdea = (task.readiness ?? 'estimated') === 'idea';
  const isCompact = density === 'compact';
  const isDetailed = density === 'detailed';

  // Shared menu button rendered in all non-overlay/non-dragging states
  const menuButton = (
    <div ref={menuRef} className="absolute top-2 right-2">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setMenuOpen(!menuOpen);
          setMoveOpen(false);
        }}
        className="w-6 h-6 flex items-center justify-center rounded text-neutral-text-secondary
          hover:bg-neutral-surface-raised opacity-0 group-hover:opacity-100
          focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-brand-primary
          focus-visible:ring-offset-1"
        aria-label={`Actions for ${task.name}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
      >
        ···
      </button>

      {menuOpen && (
        <div
          role="menu"
          className="absolute right-0 top-7 z-20 bg-neutral-surface border border-neutral-border
            rounded-md py-1 min-w-[160px]"
        >
          <button
            type="button"
            role="menuitem"
            className="w-full text-left px-3 py-2 text-sm text-neutral-text-primary
              hover:bg-neutral-surface-raised
              focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-inset"
            onClick={(e) => {
              e.stopPropagation();
              setMoveOpen(!moveOpen);
            }}
            aria-haspopup="menu"
            aria-expanded={moveOpen}
          >
            Move to…
          </button>

          {moveOpen && (
            <div role="menu" className="border-t border-neutral-border">
              {otherColumns.map((col) => (
                <button
                  key={col.status}
                  type="button"
                  role="menuitem"
                  className="w-full text-left px-5 py-2 text-sm text-neutral-text-primary
                    hover:bg-neutral-surface-raised
                    focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-inset"
                  onClick={(e) => {
                    e.stopPropagation();
                    onMenuMove(col.status);
                    setMenuOpen(false);
                    setMoveOpen(false);
                  }}
                >
                  {col.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );

  // Shared card container class
  const containerClass = [
    'bg-neutral-surface border rounded-md cursor-grab active:cursor-grabbing relative group',
    'focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
    task.isCritical
      ? 'border-semantic-critical border-2'
      : isIdea
        ? 'border-dashed border-neutral-border'
        : 'border-neutral-border',
  ].join(' ');

  // Overlay card — the floating drag copy (rule 102)
  if (isOverlay) {
    return (
      <div
        className="bg-neutral-surface border border-neutral-border rounded-md p-3
          ring-2 ring-brand-primary opacity-60 scale-105 motion-safe:rotate-1
          w-[85vw] md:w-auto md:min-w-[200px]"
      >
        <div className="flex items-center gap-1.5">
          <BoardProgressRing progress={task.progress} isCritical={task.isCritical} isStalled={isStalled} />
          <p className="text-sm font-medium text-neutral-text-primary truncate">
            {task.name}
          </p>
        </div>
      </div>
    );
  }

  // Placeholder slot when this card is being dragged (rule 102) — height
  // matches the source card so surrounding cards don't jump during drag.
  if (isDragging) {
    return (
      <div
        className="border-2 border-dashed border-neutral-border rounded-md"
        style={{ height: lastHeightRef.current || 76 }}
      />
    );
  }

  // Compact density — title + CP chip + progress strip, ~36px (issue #193)
  if (isCompact) {
    const progressColor =
      task.isCritical
        ? 'bg-semantic-critical'
        : task.progress === 100
          ? 'bg-semantic-on-track'
          : 'bg-brand-primary';
    return (
      <div
        ref={measureCardRef}
        {...listeners}
        {...attributes}
        className={containerClass}
        role="button"
        tabIndex={0}
        aria-label={`${task.name}, ${task.progress}% complete${task.isCritical ? ', critical path' : ''}`}
      >
        <div className={`absolute left-0 inset-y-0 w-1 rounded-l-md ${accentBarClass(task)}`} aria-hidden="true" />
        <div className="pl-2.5 pr-8 py-2 flex items-center gap-1 min-w-0">
          <span
            className={[
              'text-xs font-medium truncate flex-1 min-w-0',
              task.isCritical
                ? 'text-semantic-critical font-semibold'
                : isIdea
                  ? 'text-neutral-text-disabled italic'
                  : 'text-neutral-text-primary',
            ].join(' ')}
            title={task.isCritical ? cpTooltip(task) : undefined}
          >
            {task.name}
          </span>
          {task.isCritical && (
            <span
              className="shrink-0 inline-block px-1 py-px rounded text-xs text-white bg-semantic-critical font-bold"
              aria-hidden="true"
            >
              CP
            </span>
          )}
        </div>
        {/* 3px progress strip at the bottom of each compact card */}
        <div className="absolute bottom-0 left-1 right-1 h-[3px] rounded-full overflow-hidden bg-neutral-border" aria-hidden="true">
          <div className={`h-full ${progressColor}`} style={{ width: `${task.progress}%` }} />
        </div>
        {menuButton}
      </div>
    );
  }

  // Comfortable and Detailed density
  const showNudge = task.progress === 100 && task.status !== 'COMPLETE';
  // In detailed mode show all assignees; comfortable caps at 3
  const visibleAssignees = isDetailed ? task.assignees : task.assignees.slice(0, 3);
  const hiddenCount = isDetailed ? 0 : Math.max(0, task.assignees.length - 3);

  // Float chip (issue #183): CP tasks have 0d float by definition; non-CP shows totalFloat when set.
  const hasFloatData = task.isCritical || (task.totalFloat !== undefined && task.totalFloat !== null);
  const floatDays = task.isCritical ? 0 : (task.totalFloat as number);

  // Baseline variance hover panel (issue #186): calendar days between forecast finish and baseline.
  // Positive = late. Shown only when baselineFinish is present.
  const baselineVarianceDays: number | null = task.baselineFinish
    ? Math.round(
        (new Date(task.finish).getTime() - new Date(task.baselineFinish).getTime()) / 86_400_000,
      )
    : null;

  return (
    <div
      ref={measureCardRef}
      {...listeners}
      {...attributes}
      className={containerClass}
      role="button"
      tabIndex={0}
      aria-label={`${task.name}, ${task.progress}% complete${task.isCritical ? ', critical path' : ''}`}
    >
      {/* Left accent bar — rounded-l-md matches card's border-radius so the bar
          respects the card corners without needing overflow-hidden on the parent. */}
      <div className={`absolute left-0 inset-y-0 w-1 rounded-l-md ${accentBarClass(task)}`} aria-hidden="true" />

      {/* Card content — left-padded to clear the accent bar */}
      <div className="pl-2.5 pr-2.5 pt-2.5 pb-2.5">
        {/* Readiness chip — top-left (issue #179) */}
        {task.readiness && (
          <div className="mb-1.5">
            <ReadinessChip readiness={task.readiness} />
          </div>
        )}

        {/* Priority rank — top-right, below the ··· menu */}
        {task.priorityRank !== undefined && (
          <span
            className="absolute top-2 right-8 text-xs text-neutral-text-disabled"
            aria-hidden="true"
          >
            #{task.priorityRank}
          </span>
        )}

        {/* Task name row */}
        <div className="flex items-center gap-1.5 pr-6 min-w-0">
          {!isIdea && (
            <BoardProgressRing
              progress={task.progress}
              isCritical={task.isCritical}
              isStalled={isStalled}
            />
          )}
          <span
            className={[
              'text-xs font-medium truncate min-w-0',
              task.isCritical
                ? 'text-semantic-critical font-semibold'
                : isIdea
                  ? 'text-neutral-text-disabled italic'
                  : 'text-neutral-text-primary',
            ].join(' ')}
            title={task.isCritical ? cpTooltip(task) : undefined}
          >
            {task.name}
          </span>
        </div>

        {/* Badge row — CP, assignee initials (or ? placeholder for idea cards) */}
        {(task.isCritical || task.assignees.length > 0 || isIdea) && (
          <div className="flex items-center gap-1 mt-1.5 flex-wrap">
            {task.isCritical && (
              <span
                className="inline-block px-1 py-px rounded text-xs text-white bg-semantic-critical font-bold"
                aria-hidden="true"
              >
                CP
              </span>
            )}
            {isIdea ? (
              <span
                className="inline-block w-5 h-5 rounded-full border border-dashed border-neutral-border
                  flex items-center justify-center text-xs text-neutral-text-disabled"
                aria-label="Unassigned"
              >
                ?
              </span>
            ) : (
              <>
                {visibleAssignees.map((a) => (
                  <span
                    key={a.resourceId}
                    className="inline-block px-1 py-px rounded text-xs text-white bg-brand-primary font-bold"
                    title={`${a.name} (${Math.round(a.units * 100)}%)`}
                    aria-hidden="true"
                  >
                    {initials(a.name)}
                  </span>
                ))}
                {hiddenCount > 0 && (
                  <span
                    className="inline-block px-1 py-px rounded text-xs text-white bg-brand-primary font-bold"
                    aria-hidden="true"
                  >
                    +{hiddenCount}
                  </span>
                )}
              </>
            )}
          </div>
        )}

        {/* Entry stamp — comfortable: only when non-empty; detailed: always when available */}
        {stampText && (
          <div
            className={[
              'text-xs mt-1',
              isStalled ? 'text-semantic-at-risk font-medium' : 'text-neutral-text-disabled',
            ].join(' ')}
          >
            {stampText}
          </div>
        )}

        {/* Aging / dwell-time indicator (issue #192): shown when dwell > column SLA. */}
        {isAging && (
          <div
            className={[
              'mt-1 inline-flex items-center gap-0.5 text-xs px-1 py-px rounded border',
              isPastTwiceSla
                ? 'bg-semantic-critical/10 border-semantic-critical/30 text-semantic-critical motion-safe:animate-pulse'
                : 'bg-brand-accent/10 border-brand-accent/30 text-brand-accent-dark',
            ].join(' ')}
            title={`${daysAgo}d in column — SLA: ${slaDays}d`}
            aria-label={`${daysAgo} days in this column, exceeds ${slaDays}-day SLA`}
          >
            <span aria-hidden="true">⏱</span>
            <span className="tppm-mono">{daysAgo}d</span>
          </div>
        )}

        {/* Float chip — comfortable + detailed, when CPM data is present (issue #183).
            CP tasks always show "0d float" (red); non-CP shows totalFloat when defined. */}
        {!isCompact && hasFloatData && (
          <div className="mt-1">
            <span
              className={[
                'inline-flex items-center gap-0.5 text-xs px-1 py-px rounded border',
                floatDays <= 0
                  ? 'bg-semantic-critical/10 border-semantic-critical/30 text-semantic-critical'
                  : floatDays < 3
                    ? 'bg-brand-accent/10 border-brand-accent/30 text-brand-accent-dark'
                    : 'bg-semantic-on-track/10 border-semantic-on-track/30 text-semantic-on-track',
              ].join(' ')}
            >
              {floatDays < 0 && <span aria-hidden="true">⚠</span>}
              <span className="tppm-mono">{floatDays}d float</span>
            </span>
          </div>
        )}

        {/* Baseline vs. forecast date variance — hover/focus panel (issue #186).
            Hidden by default; revealed on group-hover or group-focus-within. */}
        {baselineVarianceDays !== null && (
          <div
            className="hidden group-hover:block group-focus-within:block mt-1.5 pt-1 border-t border-neutral-border/30"
            aria-label={`Baseline variance: ${baselineVarianceDays > 0 ? '+' : ''}${baselineVarianceDays}d`}
          >
            <div className="flex items-center gap-1.5 flex-wrap text-xs">
              <span className="text-neutral-text-disabled">
                BL <span className="tppm-mono">{formatShortDate(task.baselineFinish!)}</span>
              </span>
              <span className="text-neutral-text-disabled" aria-hidden="true">→</span>
              <span className="text-neutral-text-secondary">
                FC <span className="tppm-mono">{formatShortDate(task.finish)}</span>
              </span>
              <span
                className={[
                  'font-medium tppm-mono',
                  baselineVarianceDays > 5
                    ? 'text-semantic-critical'
                    : baselineVarianceDays > 0
                      ? 'text-semantic-at-risk'
                      : 'text-semantic-on-track',
                ].join(' ')}
              >
                {baselineVarianceDays > 0 ? '+' : ''}{baselineVarianceDays}d
              </span>
            </div>
          </div>
        )}

        {/* 100%-complete nudge */}
        {showNudge && (
          <div className="text-xs text-brand-primary mt-1 font-medium">
            Move to Done?
          </div>
        )}
      </div>{/* end padding wrapper */}

      {menuButton}
    </div>
  );
}
