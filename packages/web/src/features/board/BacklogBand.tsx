/**
 * BacklogBand — left-side rail that holds every BACKLOG card across the
 * project, phase-agnostic (epic #361 / ADR-0057, Claude Design rail layout).
 *
 * Why a rail, not an inline column or a horizontal strip: BACKLOG is intake —
 * undated, unrefined, not-yet-committed work. A column inside every phase
 * forces premature phase assignment; a top strip works but pushes the phase
 * grid below the fold. The rail keeps the inbox visible while the user works
 * the active board, and demotes/promotes happen via drag across the divider.
 *
 * Drag rules (handled in BoardView.tsx):
 *   rail → phase column      → status changes to the column's status
 *   phase TO DO → rail       → confirmation dialog (Option C, ADR-0057)
 *   phase IN_PROGRESS+ → rail → blocked (work has begun, no demotion)
 *
 * Sibling layouts (drawer, queue) are filed as #383 / #384 and consume the
 * same `BACKLOG_BAND_DROPPABLE_ID`.
 */
import { useCallback, useEffect, useState } from 'react';
import { useDraggable, useDroppable } from '@dnd-kit/core';
import type { Task, TaskStatus, TaskReadiness } from '@/types';

const STORAGE_KEY = 'trueppm.board.backlogBand.collapsed';

/** Persist collapsed state per-user across sessions. The rail exists on every
 * project board, so the preference is a personal habit rather than per-project
 * state. Read errors (private mode, quota) fall through to "expanded" so a
 * card never appears lost. */
function useBacklogRailCollapsed(): [boolean, (next: boolean) => void] {
  const [collapsed, setCollapsedState] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const setCollapsed = useCallback((next: boolean) => {
    setCollapsedState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, []);
  return [collapsed, setCollapsed];
}

// ---------------------------------------------------------------------------
// Atoms — small parts of a BacklogCard. Local to this file so they don't leak
// into other surfaces; the design treats backlog cards as a separate visual
// language from BoardCard (no progress bars, no SPI/CP chips, etc.).
// ---------------------------------------------------------------------------

interface AvatarProps {
  initials: string | null;
  size?: number;
}

const RESOURCE_COLOR_PALETTE = ['#1C6B3A', '#C17A10', '#0EA5E9', '#7C3AED', '#DC2626', '#0891B2'];

function colorForInitials(initials: string): string {
  let hash = 0;
  for (let i = 0; i < initials.length; i++) hash = (hash * 31 + initials.charCodeAt(i)) | 0;
  return RESOURCE_COLOR_PALETTE[Math.abs(hash) % RESOURCE_COLOR_PALETTE.length];
}

function Avatar({ initials, size = 18 }: AvatarProps) {
  if (!initials) {
    return (
      <span
        aria-hidden="true"
        className="inline-flex items-center justify-center rounded-full border border-dashed border-neutral-border text-neutral-text-disabled"
        style={{ width: size, height: size, fontSize: size <= 18 ? 9 : 10, flexShrink: 0 }}
      >
        ?
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className="inline-flex items-center justify-center rounded-full font-semibold text-white"
      style={{
        width: size,
        height: size,
        backgroundColor: colorForInitials(initials),
        fontSize: size <= 18 ? 9 : 10,
        letterSpacing: '0.02em',
        flexShrink: 0,
      }}
    >
      {initials.slice(0, 2).toUpperCase()}
    </span>
  );
}

interface ReadinessChipProps {
  readiness: TaskReadiness;
}

function ReadinessChip({ readiness }: ReadinessChipProps) {
  const styles: Record<TaskReadiness, string> = {
    idea: 'border border-dashed border-neutral-border text-neutral-text-disabled',
    estimated: 'bg-neutral-surface-sunken text-neutral-text-secondary',
    ready: 'text-brand-primary-dark dark:text-brand-primary',
    baselined: 'bg-neutral-surface-sunken text-neutral-text-secondary',
  };
  // 'ready' uses brand-accent-light which doesn't exist as a Tailwind utility
  // mapping cleanly to a single class; render with inline backgroundColor so
  // the brand-primary-light token from the design tokens is applied without
  // a Tailwind class round-trip.
  const inlineBg = readiness === 'ready' ? 'var(--brand-primary-light, #D4EDDA)' : undefined;
  return (
    <span
      className={`inline-flex items-center rounded-sm uppercase tracking-wider font-semibold ${styles[readiness]}`}
      style={{
        height: 16,
        padding: '0 6px',
        fontSize: '10px',
        letterSpacing: '0.06em',
        backgroundColor: inlineBg,
      }}
    >
      {readiness}
    </span>
  );
}

interface PriorityDotProps {
  /** 1 (low) – 5 (urgent). Falls back to "no rank" treatment when undefined. */
  rank: number | undefined;
}

function PriorityDot({ rank }: PriorityDotProps) {
  // Three-bar histogram. Each bar is "lit" if rank >= bar*2 (so rank 1 lights
  // none, 2 lights the shortest, 4 lights two, 5 lights all three).
  const r = rank ?? 0;
  const colorClass =
    r >= 5
      ? 'bg-semantic-critical'
      : r >= 4
        ? 'bg-brand-accent-dark'
        : r >= 3
          ? 'bg-neutral-text-secondary'
          : 'bg-neutral-text-disabled';
  return (
    <span
      title={rank ? `Priority ${rank}` : 'No priority'}
      className="inline-flex items-end gap-[1.5px]"
      style={{ height: 10, flexShrink: 0 }}
    >
      {[1, 2, 3].map((b) => (
        <span
          key={b}
          className={r >= b * 2 ? colorClass : 'bg-neutral-border'}
          style={{ width: 2, height: 4 + (b - 1) * 2, borderRadius: 0.5 }}
        />
      ))}
    </span>
  );
}

interface PhaseDotProps {
  color: string;
  size?: number;
}

function PhaseDot({ color, size = 6 }: PhaseDotProps) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: 999,
        backgroundColor: color,
        flexShrink: 0,
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// BacklogCard — distinct from BoardCard. No progress bar (BACKLOG is undated),
// no SPI / EVM, no cost. Compact / comfortable / full densities.
// ---------------------------------------------------------------------------

export type BacklogCardDensity = 'compact' | 'comfortable' | 'full';

export interface BacklogCardProps {
  task: Task;
  density: BacklogCardDensity;
  phaseColor: string;
  /** Computed once per task by the rail — days since `statusEnteredAt`. */
  ageDays: number | null;
  isFocused: boolean;
  onFocus: () => void;
  onClick: (anchor: HTMLElement) => void;
  /** Keyboard alternative for promotion (#318, rule 135) — opens the shared
   *  ScheduleTaskDialog. The card passes its own `···` button as the trigger so
   *  focus can be returned on close. When omitted, the action is not rendered. */
  onSchedule?: (task: Task, trigger: HTMLElement) => void;
}

function ownerInitialsFromTask(task: Task): string | null {
  const first = task.assignees[0];
  if (!first) return null;
  const parts = first.name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2);
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * The `···` "Schedule…" overflow action for a backlog card (#318, rule 135).
 *
 * Rendered as a sibling of the card's drag-source `<button>` (never nested —
 * an interactive control inside a button is invalid HTML and breaks the drag
 * activation). Positioned in the card's top-right; the trigger element is
 * handed to `onSchedule` so the dialog can return focus on close.
 */
function ScheduleAction({
  task,
  onSchedule,
}: {
  task: Task;
  onSchedule: (task: Task, trigger: HTMLElement) => void;
}) {
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      aria-label={`Actions for ${task.name}`}
      title="Schedule…"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onSchedule(task, e.currentTarget);
      }}
      className="absolute top-1 right-1 w-6 h-6 flex items-center justify-center rounded
        text-neutral-text-secondary hover:text-neutral-text-primary hover:bg-neutral-surface-raised
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
    >
      <span aria-hidden="true" className="leading-none">···</span>
    </button>
  );
}

export function BacklogCard({
  task,
  density,
  phaseColor,
  ageDays,
  isFocused,
  onFocus,
  onClick,
  onSchedule,
}: BacklogCardProps) {
  const initials = ownerInitialsFromTask(task);
  const readiness: TaskReadiness = task.readiness ?? 'idea';
  const isIdeaTone = readiness === 'idea';
  const focusRing = isFocused ? 'ring-2 ring-brand-primary' : '';

  // Drag source — the card is grabbable into a phase column (BoardView's
  // handleDragEnd reads active.id == task.id). The pointer activation here
  // is what BoardCard uses too; dnd-kit owns pointerDown, so the focus
  // tracker rides on the React onFocus event instead of onPointerDown.
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.id,
  });
  const dragOpacity = isDragging ? 'opacity-60' : '';

  if (density === 'compact') {
    return (
      <div className="relative">
        <button
          ref={setNodeRef}
          type="button"
          aria-label={`${task.name}, backlog idea`}
          onFocus={onFocus}
          onClick={(e) => onClick(e.currentTarget)}
          {...attributes}
          {...listeners}
          className={`flex w-full items-center gap-2 rounded-sm border border-neutral-border bg-neutral-surface px-2.5 py-1.5 text-left cursor-grab focus-visible:outline-none ${onSchedule ? 'pr-7' : ''} ${focusRing} ${dragOpacity}`}
        >
          <PriorityDot rank={task.priorityRank} />
          <span
            className={`flex-1 min-w-0 truncate text-xs font-medium ${
              isIdeaTone ? 'italic text-neutral-text-secondary' : 'text-neutral-text-primary'
            }`}
          >
            {task.name}
          </span>
          <PhaseDot color={phaseColor} />
          <Avatar initials={initials} size={16} />
        </button>
        {onSchedule && <ScheduleAction task={task} onSchedule={onSchedule} />}
      </div>
    );
  }

  return (
    <div className="relative">
      <button
        ref={setNodeRef}
        type="button"
        aria-label={`${task.name}, backlog idea`}
        onFocus={onFocus}
        onClick={(e) => onClick(e.currentTarget)}
        {...attributes}
        {...listeners}
        className={`flex w-full flex-col gap-1.5 rounded-md border border-neutral-border bg-neutral-surface px-3 py-2.5 text-left cursor-grab focus-visible:outline-none ${focusRing} ${dragOpacity}`}
        style={{ borderLeft: `3px solid ${phaseColor}` }}
      >
        <div className="flex items-center gap-1.5">
          <PriorityDot rank={task.priorityRank} />
          <ReadinessChip readiness={readiness} />
          {(task.predecessorCount ?? 0) > 0 && (
            <span
              aria-label="Linked dependency"
              title="Linked dependency"
              className="text-neutral-text-disabled leading-none"
              style={{ fontSize: 12 }}
            >
              ⛓
            </span>
          )}
          <span className="flex-1" />
          {/* Reserve room for the absolutely-positioned ··· so the avatar
              doesn't sit under it. */}
          <span className={onSchedule ? 'pr-6' : ''}>
            <Avatar initials={initials} />
          </span>
        </div>

        <div
          className={`text-[13px] font-medium leading-snug ${
            isIdeaTone ? 'italic text-neutral-text-secondary' : 'text-neutral-text-primary'
          }`}
        >
          {task.name}
        </div>

        {density === 'full' && (
          <div className="flex items-center gap-2 text-xs text-neutral-text-secondary">
            <span style={{ color: phaseColor }} className="font-semibold">
              {/* Phase name is sourced via prop in future; for now show the WBS
                  root label since the rail is project-scoped. */}
              {task.parentId ? 'Phase' : 'Project'}
            </span>
            <span aria-hidden="true">·</span>
            <span className="tppm-mono">P{task.priorityRank ?? '—'}</span>
            {task.duration > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <span className="tppm-mono">{task.duration}d</span>
              </>
            )}
            <span className="flex-1" />
            {ageDays !== null && (
              <span className="tppm-mono text-neutral-text-disabled">
                {ageDays}d ago
              </span>
            )}
          </div>
        )}
      </button>
      {onSchedule && <ScheduleAction task={task} onSchedule={onSchedule} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rail body — header / search / hint / list / capture CTA. Re-exported as the
// canonical "BacklogBand" so the existing BoardView import stays stable.
// ---------------------------------------------------------------------------

export const BACKLOG_BAND_DROPPABLE_ID = 'backlog-band';

export interface BacklogBandProps {
  tasks: Task[];
  /** Density preference for backlog cards. Comes from the toolbar (#382 will
   * wire a UI; for now defaults to 'comfortable'). */
  density?: BacklogCardDensity;
  isDragActive: boolean;
  isOver: boolean;
  /** Phase color resolver — keyed by `parentId` (or 'root' for ungrouped).
   * Falls back to a neutral grey when the parent isn't in the project's WBS. */
  phaseColorFor: (parentId: string | null) => string;
  focusedCardId: string | null;
  onCardFocus: (taskId: string, status: TaskStatus, phaseId: string) => void;
  onCardClick: (task: Task, anchor: HTMLElement) => void;
  /** Keyboard alternative for promotion (#318, rule 135) — opens the shared
   *  ScheduleTaskDialog (mounted once in BoardView). Passed straight to each
   *  BacklogCard's `···` "Schedule…" action. */
  onSchedule?: (task: Task, trigger: HTMLElement) => void;
  /** Called when the user clicks "+ Capture idea". Creates a new BACKLOG task. */
  onCaptureIdea?: () => void;
  /** True while the create mutation is in flight — disables the button. */
  isCaptureIdeaPending?: boolean;
}

export function ageInDays(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.floor(ms / 86_400_000);
}

export function BacklogBand({
  tasks,
  density = 'comfortable',
  isDragActive,
  isOver,
  phaseColorFor,
  focusedCardId,
  onCardFocus,
  onCardClick,
  onSchedule,
  onCaptureIdea,
  isCaptureIdeaPending = false,
}: BacklogBandProps) {
  const [collapsed, setCollapsed] = useBacklogRailCollapsed();
  const { setNodeRef } = useDroppable({ id: BACKLOG_BAND_DROPPABLE_ID });

  // Drag mid-flight auto-expands the rail so the user can drop into it without
  // a separate gesture. We only force-expand; never auto-collapse mid-drag.
  const [forcedExpand, setForcedExpand] = useState(false);
  useEffect(() => {
    if (isDragActive && collapsed) setForcedExpand(true);
    if (!isDragActive) setForcedExpand(false);
  }, [isDragActive, collapsed]);

  const isExpanded = !collapsed || forcedExpand;
  const overTint = isOver && isDragActive;

  // Sort by statusEnteredAt descending — most recent ideas land at the top.
  // Tasks without the field sort to the bottom (treated as oldest).
  const sortedTasks = [...tasks].sort((a, b) => {
    const at = a.statusEnteredAt ?? '';
    const bt = b.statusEnteredAt ?? '';
    if (at === bt) return 0;
    return at < bt ? 1 : -1;
  });

  // Collapsed: 44px vertical strip with rotated count.
  if (!isExpanded) {
    return (
      <button
        type="button"
        ref={setNodeRef}
        onClick={() => setCollapsed(false)}
        aria-expanded={false}
        aria-controls="backlog-rail-body"
        aria-label={`Expand backlog rail, ${tasks.length} ${tasks.length === 1 ? 'idea' : 'ideas'}`}
        data-testid="backlog-band"
        className={[
          'flex flex-col items-center gap-3 py-4 cursor-pointer',
          'border-r border-neutral-border bg-neutral-surface-raised',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-inset',
          overTint ? 'bg-brand-primary/5' : '',
        ].join(' ')}
        style={{ width: 44, flexShrink: 0 }}
      >
        <span aria-hidden="true" className="text-base text-neutral-text-secondary">
          ›
        </span>
        <span
          className="text-[11px] font-semibold uppercase tracking-widest text-neutral-text-secondary"
          style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
        >
          Backlog · {tasks.length}
        </span>
      </button>
    );
  }

  return (
    <aside
      ref={setNodeRef}
      data-testid="backlog-band"
      aria-labelledby="backlog-rail-heading"
      className={[
        'flex flex-col min-h-0 border-r border-neutral-border bg-neutral-surface-raised flex-shrink-0',
        overTint ? 'bg-brand-primary/5' : '',
      ].join(' ')}
      style={{ width: density === 'compact' ? 280 : 320 }}
    >
      {/* Header — eyebrow + count + collapse toggle */}
      <div className="flex items-center gap-2 px-4 pt-3.5 pb-2.5">
        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold uppercase tracking-widest text-neutral-text-secondary">
            Inbox · backlog
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span
              id="backlog-rail-heading"
              className="text-lg font-semibold text-neutral-text-primary"
              aria-label={`${tasks.length} ${tasks.length === 1 ? 'idea' : 'ideas'} in backlog`}
            >
              {tasks.length}
            </span>
            <span className="text-xs text-neutral-text-secondary">
              {tasks.length === 1 ? 'idea' : 'ideas'}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          aria-expanded
          aria-controls="backlog-rail-body"
          aria-label="Collapse backlog rail"
          title="Collapse"
          className="inline-flex items-center justify-center rounded border border-neutral-border bg-neutral-surface text-neutral-text-secondary
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          style={{ width: 24, height: 24 }}
        >
          ‹
        </button>
      </div>

      {/* Search row — visual placeholder. Capture/search wiring is queued in
          a follow-up under epic #361. */}
      <div className="px-4 pb-2.5">
        <div
          className="flex items-center gap-2 rounded-md border border-neutral-border bg-neutral-surface px-2.5 text-xs text-neutral-text-disabled"
          style={{ height: 30 }}
          role="search"
          aria-label="Search backlog (placeholder)"
        >
          <span aria-hidden="true">⌕</span>
          <span className="flex-1">Search or capture an idea…</span>
          <span className="tppm-mono text-xs">⌘K</span>
        </div>
      </div>

      {/* Hint — orientation copy for first-time users. */}
      <div className="px-4 pb-2.5 text-[11px] leading-snug text-neutral-text-secondary">
        Drag right onto a phase to promote to{' '}
        <strong className="font-semibold text-neutral-text-primary">To do</strong>.
      </div>

      {/* List — flex column with capture CTA pinned at the end. */}
      <div
        id="backlog-rail-body"
        className="flex-1 min-h-0 overflow-y-auto px-3 pb-4 pt-1 flex flex-col gap-1.5"
        role="list"
        aria-label="Backlog cards"
      >
        {sortedTasks.length === 0 ? (
          <div
            className="flex-1 flex items-center justify-center rounded-md border border-dashed border-neutral-border text-xs italic text-neutral-text-secondary"
            role="status"
            style={{ minHeight: 88 }}
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
                  onFocus={() =>
                    onCardFocus(task.id, task.status, task.parentId ?? 'root')
                  }
                  onClick={(anchor) => onCardClick(task, anchor)}
                  onSchedule={onSchedule}
                />
              </div>
            );
          })
        )}

        <button
          type="button"
          onClick={onCaptureIdea}
          disabled={isCaptureIdeaPending || !onCaptureIdea}
          aria-busy={isCaptureIdeaPending}
          className="mt-1.5 flex items-center justify-center gap-1.5 rounded-md border border-dashed border-neutral-border bg-transparent text-xs text-neutral-text-disabled
            hover:border-brand-primary hover:text-brand-primary disabled:opacity-50 disabled:cursor-not-allowed
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          style={{ height: 36 }}
        >
          <span aria-hidden="true" style={{ fontSize: 14, lineHeight: 0 }}>+</span>
          {isCaptureIdeaPending ? 'Adding…' : 'Capture idea'}
        </button>
      </div>
    </aside>
  );
}
