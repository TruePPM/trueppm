import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { useDraggable } from '@dnd-kit/core';
import type { Task, TaskReadiness, TaskStatus } from '@/types';
import { BoardProgressRing } from './BoardProgressRing';

interface BoardCardProps {
  task: Task;
  isOverlay?: boolean;
  isStalled?: boolean;
  onMenuMove: (newStatus: TaskStatus) => void;
  columns: { status: TaskStatus; label: string }[];
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
 * Format an entry-stamp line.
 * e.g. "Entered at 62% · 4d ago"   (when statusEnteredAt is known)
 *      "In progress"                 (fallback)
 */
function entryStamp(task: Task): { text: string; isStalled: boolean } {
  if (!task.statusEnteredAt) {
    // Fallback: no timestamp
    return { text: '', isStalled: false };
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

export function BoardCard({ task, isOverlay, isStalled: isOverrideStalled, onMenuMove, columns }: BoardCardProps) {
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
  const { text: stampText, isStalled: derivedStalled } = entryStamp(task);
  const isStalled = isOverrideStalled ?? derivedStalled;

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

  // At-100% nudge: "Move to Done?" (also triggers on REVIEW → Done)
  const showNudge =
    task.progress === 100 && task.status !== 'COMPLETE';

  const isIdea = (task.readiness ?? 'estimated') === 'idea';

  return (
    <div
      ref={measureCardRef}
      {...listeners}
      {...attributes}
      className={[
        'bg-neutral-surface border rounded-md cursor-grab active:cursor-grabbing relative group',
        'focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
        task.isCritical
          ? 'border-semantic-critical border-2'
          : isIdea
            ? 'border-dashed border-neutral-border'
            : 'border-neutral-border',
      ].join(' ')}
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
          title={task.isCritical ? 'This task is on the critical path — a delay here delays the project end date' : undefined}
        >
          {task.name}
        </span>
      </div>

      {/* rpill badges — CP, assignee initials (or ? placeholder for idea cards) */}
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
              {task.assignees.slice(0, 3).map((a) => (
                <span
                  key={a.resourceId}
                  className="inline-block px-1 py-px rounded text-xs text-white bg-brand-primary font-bold"
                  title={`${a.name} (${Math.round(a.units * 100)}%)`}
                  aria-hidden="true"
                >
                  {initials(a.name)}
                </span>
              ))}
              {task.assignees.length > 3 && (
                <span
                  className="inline-block px-1 py-px rounded text-xs text-white bg-brand-primary font-bold"
                  aria-hidden="true"
                >
                  +{task.assignees.length - 3}
                </span>
              )}
            </>
          )}
        </div>
      )}

      {/* Entry stamp */}
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

      {/* 100%-complete nudge */}
      {showNudge && (
        <div className="text-xs text-brand-primary mt-1 font-medium">
          Move to Done?
        </div>
      )}

      {/* Overflow menu — keyboard move alternative (rule 105) */}
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
      </div>{/* end padding wrapper */}
    </div>
  );
}
