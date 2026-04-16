import { useState, useRef, useEffect } from 'react';
import { useDraggable } from '@dnd-kit/core';
import type { Task, TaskStatus } from '@/types';
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

export function BoardCard({ task, isOverlay, isStalled: isOverrideStalled, onMenuMove, columns }: BoardCardProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.id,
  });

  const [menuOpen, setMenuOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

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

  // Placeholder slot when this card is being dragged (rule 102)
  if (isDragging) {
    return (
      <div className="border-2 border-dashed border-neutral-border rounded-md p-3 h-[76px]" />
    );
  }

  // At-100% nudge: "Move to Done?"
  const showNudge = task.progress === 100 && task.status !== 'COMPLETE';

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={[
        'bg-neutral-surface border rounded-md p-2.5 cursor-grab active:cursor-grabbing relative group',
        'focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
        task.isCritical
          ? 'border-semantic-critical border-2'
          : 'border-neutral-border',
      ].join(' ')}
      role="button"
      tabIndex={0}
      aria-label={`${task.name}, ${task.progress}% complete${task.isCritical ? ', critical path' : ''}`}
    >
      {/* Priority rank — top-right, below the ··· menu */}
      {task.priorityRank !== undefined && (
        <span
          className="absolute top-2 right-8 text-neutral-text-disabled"
          style={{ fontSize: 9 }}
          aria-hidden="true"
        >
          #{task.priorityRank}
        </span>
      )}

      {/* Task name row */}
      <div className="flex items-center gap-1.5 pr-6 min-w-0">
        <BoardProgressRing
          progress={task.progress}
          isCritical={task.isCritical}
          isStalled={isStalled}
        />
        <span
          className={[
            'text-xs font-medium truncate min-w-0',
            task.isCritical
              ? 'text-semantic-critical font-semibold'
              : 'text-neutral-text-primary',
          ].join(' ')}
          title={task.isCritical ? 'This task is on the critical path — a delay here delays the project end date' : undefined}
        >
          {task.name}
        </span>
      </div>

      {/* rpill badges — CP and assignee initials */}
      {(task.isCritical || task.assignees.length > 0) && (
        <div className="flex items-center gap-1 mt-1.5 flex-wrap">
          {task.isCritical && (
            <span
              className="inline-block px-1 py-px rounded text-white bg-semantic-critical font-bold"
              style={{ fontSize: 10 }}
              aria-hidden="true"
            >
              CP
            </span>
          )}
          {task.assignees.slice(0, 3).map((a) => (
            <span
              key={a.resourceId}
              className="inline-block px-1 py-px rounded text-white bg-brand-primary font-bold"
              style={{ fontSize: 10 }}
              title={`${a.name} (${Math.round(a.units * 100)}%)`}
              aria-hidden="true"
            >
              {initials(a.name)}
            </span>
          ))}
          {task.assignees.length > 3 && (
            <span
              className="inline-block px-1 py-px rounded text-white bg-brand-primary font-bold"
              style={{ fontSize: 10 }}
              aria-hidden="true"
            >
              +{task.assignees.length - 3}
            </span>
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
    </div>
  );
}
