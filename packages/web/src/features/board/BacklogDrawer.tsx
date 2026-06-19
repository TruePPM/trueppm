/**
 * BacklogDrawer — top horizontal collapsible strip variant of the backlog
 * surface (epic #361 child C / issue #383, Claude Design `BacklogDrawer`).
 *
 * Renders only when `toolbarPrefs.layout === 'drawer'` (see CalmToolbar's
 * LayoutSwitcher). Sits above the phase grid as a full-width band; expands to
 * a responsive grid of BacklogCards, collapses to a single-line header bar.
 *
 * Why a drawer instead of the rail (BacklogBand): some users want the phase
 * grid to occupy the full horizontal space and treat the inbox as a top-level
 * "shelf" they expand only when triaging. The rail keeps the inbox always
 * visible at the cost of grid width.
 *
 * Drag rules — same as the rail; the drop zone uses the shared
 * BACKLOG_BAND_DROPPABLE_ID so BoardView's drag handlers do not branch.
 */
import { useCallback, useEffect, useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import type { Task, TaskStatus } from '@/types';
import {
  BACKLOG_BAND_DROPPABLE_ID,
  BacklogCard,
  ageInDays,
  type BacklogCardDensity,
} from './BacklogBand';

const STORAGE_KEY = 'trueppm.board.backlogDrawer.open';

/**
 * A backlog idea is "stalled" when it has sat in BACKLOG for more than
 * STALLED_THRESHOLD_DAYS without movement. The threshold is intentionally a
 * conservative two weeks — anything shorter punishes normal triage cadence;
 * anything longer hides genuinely-forgotten work past most sprint boundaries.
 */
const STALLED_THRESHOLD_DAYS = 14;

function useDrawerOpen(): [boolean, (next: boolean) => void] {
  const [open, setOpenState] = useState<boolean>(() => {
    try {
      // Default expanded — first-time users should see the inbox content,
      // not a hidden bar that needs discovery. Once the user collapses, the
      // preference sticks across sessions.
      const stored = localStorage.getItem(STORAGE_KEY);
      return stored !== '0';
    } catch {
      return true;
    }
  });
  const setOpen = useCallback((next: boolean) => {
    setOpenState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
    } catch {
      /* private mode — drawer reverts to default next mount, non-fatal */
    }
  }, []);
  return [open, setOpen];
}

function countStalled(tasks: Task[]): number {
  let n = 0;
  for (const t of tasks) {
    const age = ageInDays(t.statusEnteredAt);
    if (age !== null && age > STALLED_THRESHOLD_DAYS) n++;
  }
  return n;
}

export interface BacklogDrawerProps {
  tasks: Task[];
  density?: BacklogCardDensity;
  isDragActive: boolean;
  isOver: boolean;
  phaseColorFor: (parentId: string | null) => string;
  focusedCardId: string | null;
  onCardFocus: (taskId: string, status: TaskStatus, phaseId: string) => void;
  onCardClick: (task: Task, anchor: HTMLElement) => void;
}

export function BacklogDrawer({
  tasks,
  density = 'comfortable',
  isDragActive,
  isOver,
  phaseColorFor,
  focusedCardId,
  onCardFocus,
  onCardClick,
}: BacklogDrawerProps) {
  const [open, setOpen] = useDrawerOpen();
  const { setNodeRef } = useDroppable({ id: BACKLOG_BAND_DROPPABLE_ID });

  // Mid-drag the drawer auto-expands so a card can be dropped without a
  // separate gesture (mirrors BacklogBand). Only force-open; never force-close.
  const [forcedOpen, setForcedOpen] = useState(false);
  useEffect(() => {
    if (isDragActive && !open) setForcedOpen(true);
    if (!isDragActive) setForcedOpen(false);
  }, [isDragActive, open]);

  const isExpanded = open || forcedOpen;
  const overTint = isOver && isDragActive;

  const stalled = countStalled(tasks);

  // Sort newest first — same rule as the rail. Tasks without
  // statusEnteredAt sort last (treated as oldest).
  const sortedTasks = [...tasks].sort((a, b) => {
    const at = a.statusEnteredAt ?? '';
    const bt = b.statusEnteredAt ?? '';
    if (at === bt) return 0;
    return at < bt ? 1 : -1;
  });

  const headerLabel = `${tasks.length} ${tasks.length === 1 ? 'idea' : 'ideas'}`;
  const stalledLabel = stalled > 0 ? `${stalled} stalled` : null;

  return (
    <section
      ref={setNodeRef}
      data-testid="backlog-drawer"
      aria-labelledby="backlog-drawer-heading"
      className={[
        'flex flex-col flex-shrink-0 border-b border-neutral-border bg-neutral-surface-raised',
        overTint ? 'bg-brand-primary/5' : '',
      ].join(' ')}
    >
      {/* Header row — disclosure caret + count + stalled count + hint + collapse */}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={isExpanded}
        aria-controls="backlog-drawer-body"
        className="flex items-center gap-3 px-4 py-2 text-left
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-inset"
      >
        <span
          aria-hidden="true"
          className="text-base text-neutral-text-secondary inline-block"
          style={{
            transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform 150ms ease-out',
          }}
        >
          ▸
        </span>
        <span
          id="backlog-drawer-heading"
          className="text-xs font-semibold uppercase tracking-widest text-neutral-text-secondary"
        >
          Backlog
        </span>
        <span aria-hidden="true" className="text-neutral-text-disabled">
          ·
        </span>
        <span className="text-xs text-neutral-text-secondary">{headerLabel}</span>
        {stalledLabel && (
          <>
            <span aria-hidden="true" className="text-neutral-text-disabled">
              ·
            </span>
            <span
              className="text-xs text-semantic-at-risk"
              aria-label={`${stalled} stalled ${stalled === 1 ? 'idea' : 'ideas'}`}
            >
              {stalledLabel}
            </span>
          </>
        )}
        <span className="flex-1" />
        <span className="text-[11px] italic text-neutral-text-disabled hidden md:inline">
          Drag a card down to defer it back to backlog
        </span>
      </button>

      {/* Body — responsive card grid. Hidden when collapsed (no DOM remove so
          drop targets stay registered for transient mid-drag auto-expand). */}
      <div
        id="backlog-drawer-body"
        role="list"
        aria-label="Backlog cards"
        hidden={!isExpanded}
        className="grid gap-2 px-4 pb-3"
        style={{
          gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
        }}
      >
        {sortedTasks.length === 0 ? (
          <div
            className="col-span-full flex items-center justify-center rounded-card border border-dashed border-neutral-border text-xs italic text-neutral-text-secondary py-3"
            role="status"
          >
            No backlog yet — drag a card here to defer it.
          </div>
        ) : (
          sortedTasks.map((task) => {
            const phaseColor = phaseColorFor(task.parentId);
            return (
              <div key={task.id} role="listitem">
                <BacklogCard
                  task={task}
                  density={density}
                  phaseColor={phaseColor}
                  ageDays={ageInDays(task.statusEnteredAt)}
                  isFocused={focusedCardId === task.id}
                  onFocus={() => onCardFocus(task.id, task.status, task.parentId ?? 'root')}
                  onClick={(anchor) => onCardClick(task, anchor)}
                />
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
