/**
 * BacklogBand — left-side rail that holds every BACKLOG card across the
 * project, phase-agnostic (ADR-0057, rail layout).
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
import { useCallback, useEffect, useRef, useState } from 'react';
import { useDraggable, useDroppable } from '@dnd-kit/core';
import type { Task, TaskStatus, TaskReadiness } from '@/types';
import { ReadinessChip } from './ReadinessChip';

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

const RESOURCE_COLOR_PALETTE = ['#3E8C6D', '#C17A10', '#0EA5E9', '#7C3AED', '#DC2626', '#0891B2'];

function colorForInitials(initials: string): string {
  let hash = 0;
  for (let i = 0; i < initials.length; i++) hash = Math.trunc(hash * 31 + initials.charCodeAt(i));
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
      // Priority is folded into the card's accessible name (#2207); the bars are
      // a redundant visual cue, hidden from SR to avoid a color-only announcement.
      aria-hidden="true"
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
      // 24px corner action + invisible expander to the 44px touch target
      // (rule 5); already position:absolute, so the pad anchors to the button.
      className="absolute top-1 right-1 w-6 h-6 flex items-center justify-center rounded-control
        text-neutral-text-secondary hover:text-neutral-text-primary hover:bg-neutral-surface-raised
        focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1
        before:absolute before:inset-[-10px] before:content-['']"
    >
      <span aria-hidden="true" className="leading-none">
        ···
      </span>
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
          aria-label={`${task.name}, backlog idea${
            task.priorityRank ? `, priority ${task.priorityRank}` : ''
          }`}
          onFocus={onFocus}
          onClick={(e) => onClick(e.currentTarget)}
          {...attributes}
          {...listeners}
          className={`flex w-full items-center gap-2 rounded-control border border-neutral-border bg-neutral-surface px-2.5 py-1.5 text-left cursor-grab focus:outline-none ${onSchedule ? 'pr-7' : ''} ${focusRing} ${dragOpacity}`}
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
        aria-label={`${task.name}, backlog idea${
          task.priorityRank ? `, priority ${task.priorityRank}` : ''
        }`}
        onFocus={onFocus}
        onClick={(e) => onClick(e.currentTarget)}
        {...attributes}
        {...listeners}
        className={`flex w-full flex-col gap-1.5 rounded-card border border-neutral-border bg-neutral-surface px-3 py-2.5 text-left cursor-grab focus:outline-none ${focusRing} ${dragOpacity}`}
        style={{ borderLeft: `3px solid ${phaseColor}` }}
      >
        <div className="flex items-center gap-1.5">
          <PriorityDot rank={task.priorityRank} />
          <ReadinessChip readiness={readiness} variant="compact" />
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
              <span className="tppm-mono text-neutral-text-disabled">{ageDays}d ago</span>
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

/** Search only earns its slot once there is a pile to sift (#1973). Below this
 *  many ideas the inbox is capture-first: the top field captures, and the filter
 *  field is suppressed (⌘K still searches globally). */
export const BACKLOG_SEARCH_MIN_IDEAS = 8;

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
  /** Quick capture (#1973) — type a title in the top field and press Enter to
   *  create a BACKLOG idea inline, no modal. The rail clears the field and keeps
   *  focus for rapid successive intake. When omitted, the capture field is not
   *  rendered (the rail falls back to the "Add with details…" button only).
   *
   *  `opts.onError` is invoked if the create fails, so the rail can restore the
   *  typed idea it optimistically cleared (#2030) — a silent POST failure on a
   *  rapid-fire intake field otherwise loses the idea with no trace. */
  onQuickCapture?: (name: string, opts?: { onError?: () => void }) => void;
  /** True while a quick-capture create is in flight — disables the field. */
  isQuickCapturePending?: boolean;
  /** Called when the user clicks "Add with details…" — opens the full add-task
   *  modal (assignee, description, dates) with a BACKLOG default. The richer
   *  path alongside the top field's fast inline capture. */
  onCaptureIdea?: () => void;
  /** True while the create mutation is in flight — disables the button. */
  isCaptureIdeaPending?: boolean;
  /** Below MEMBER (a Viewer) or on a closed sprint (#2146): the rail is a
   *  read-only pile — the inline quick-capture field and the "Add with details…"
   *  button are both suppressed. Cards remain openable and draggable read state
   *  is unaffected. */
  readOnly?: boolean;
  /** ⌘K handoff (issue 1609) — opens the global command palette. Wired in
   *  BoardView to `useCommandPaletteStore`; kept as a prop so the rail stays
   *  decoupled from the shell store and remains unit-testable in isolation.
   *  When omitted, the ⌘K affordance is not rendered. */
  onOpenCommandPalette?: () => void;
}

export function ageInDays(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.floor(ms / 86_400_000);
}

/**
 * Client-side backlog filter (issue 1609). The rail's tasks are already fully
 * loaded in memory (BoardView partitions the project's task set), so search is a
 * case-insensitive substring match — no server round-trip. Matches the card's
 * name and any assignee name so "find Sarah's ideas" works as well as "find
 * login". An empty or whitespace-only query returns the list unchanged so the
 * happy path never pays for filtering.
 */
export function filterBacklogTasks(tasks: Task[], query: string): Task[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return tasks;
  return tasks.filter((task) => {
    if (task.name.toLowerCase().includes(needle)) return true;
    return task.assignees.some((a) => a.name.toLowerCase().includes(needle));
  });
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
  onQuickCapture,
  isQuickCapturePending = false,
  onCaptureIdea,
  isCaptureIdeaPending = false,
  onOpenCommandPalette,
  readOnly = false,
}: BacklogBandProps) {
  const [collapsed, setCollapsed] = useBacklogRailCollapsed();
  const [query, setQuery] = useState('');
  const [captureDraft, setCaptureDraft] = useState('');
  const captureInputRef = useRef<HTMLInputElement>(null);
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

  // Capture-first (#1973): the top field captures instead of searches. Search is
  // demoted to appear only once there is a pile to sift; below the threshold the
  // filter field is suppressed (⌘K still searches globally) and `query` stays ''.
  const canQuickCapture = typeof onQuickCapture === 'function' && !readOnly;
  const showSearch = tasks.length >= BACKLOG_SEARCH_MIN_IDEAS;

  const submitCapture = useCallback(() => {
    if (!onQuickCapture || isQuickCapturePending) return;
    const name = captureDraft.trim();
    if (name === '') return;
    // Clear and keep focus first so successive ideas can be captured without
    // reaching for the mouse — the whole point of an intake field — and so an
    // onError (even a synchronous one) already sees the emptied field.
    setCaptureDraft('');
    captureInputRef.current?.focus();
    onQuickCapture(name, {
      // Restore the idea we optimistically cleared if the create fails (#2030),
      // but only when the field is still empty — never clobber the next idea the
      // user has already started typing on this rapid-fire intake field.
      onError: () => setCaptureDraft((cur) => (cur === '' ? name : cur)),
    });
  }, [onQuickCapture, isQuickCapturePending, captureDraft]);

  // Live client-side filter (issue 1609). The rail owns the query string; the
  // header count stays the total inbox size so filtering never hides how much
  // backlog exists, while the list shows only matches. Search never engages
  // below the threshold, so `query` is forced empty there.
  const isFiltering = showSearch && query.trim() !== '';
  const visibleTasks = isFiltering ? filterBacklogTasks(sortedTasks, query) : sortedTasks;

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
          'focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-inset',
          overTint ? 'bg-brand-primary/5' : '',
        ].join(' ')}
        style={{ width: 44, flexShrink: 0 }}
      >
        <span aria-hidden="true" className="text-base text-neutral-text-secondary">
          ›
        </span>
        <span
          className="text-xs font-semibold uppercase tracking-widest text-neutral-text-secondary"
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
          // 24px visual control + invisible expander to the 44px touch target (rule 5).
          className="relative inline-flex items-center justify-center rounded-control border border-neutral-border bg-neutral-surface text-neutral-text-secondary
            focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1
            before:absolute before:inset-[-10px] before:content-['']"
          style={{ width: 24, height: 24 }}
        >
          ‹
        </button>
      </div>

      {/* Capture row (#1973) — the primary affordance in an intake inbox is fast
          capture, not search: type a title, press Enter to create a BACKLOG idea
          inline, the field clears and keeps focus for the next one. */}
      {canQuickCapture && (
        <div className="px-4 pb-2.5">
          <form
            aria-label="Capture a backlog idea"
            onSubmit={(e) => {
              e.preventDefault();
              submitCapture();
            }}
            className="flex items-center gap-2 rounded-control border border-neutral-border bg-neutral-surface px-2.5 text-xs
              focus-within:border-brand-primary focus-within:ring-1 focus-within:ring-brand-primary"
            style={{ height: 30 }}
          >
            <span
              aria-hidden="true"
              className="text-neutral-text-disabled"
              style={{ fontSize: 14, lineHeight: 0 }}
            >
              +
            </span>
            <input
              ref={captureInputRef}
              type="text"
              value={captureDraft}
              onChange={(e) => setCaptureDraft(e.target.value)}
              disabled={isQuickCapturePending}
              placeholder="Capture an idea…"
              aria-label="Capture a backlog idea"
              aria-keyshortcuts="Enter"
              className="flex-1 min-w-0 bg-transparent text-xs text-neutral-text-primary placeholder:text-neutral-text-secondary
                focus:outline-none disabled:cursor-not-allowed"
            />
            {captureDraft.trim() !== '' && (
              <span aria-hidden="true" className="tppm-mono text-xs text-neutral-text-disabled">
                {isQuickCapturePending ? '…' : '⏎'}
              </span>
            )}
          </form>
        </div>
      )}

      {/* Search row (issue 1609) — demoted (#1973) to appear only once there is a
          pile to sift; below the threshold ⌘K still searches globally. */}
      {showSearch && (
        <div className="px-4 pb-2.5">
          <form
            role="search"
            aria-label="Search backlog"
            onSubmit={(e) => e.preventDefault()}
            className="flex items-center gap-2 rounded-control border border-neutral-border bg-neutral-surface px-2.5 text-xs
              focus-within:border-brand-primary focus-within:ring-1 focus-within:ring-brand-primary"
            style={{ height: 30 }}
          >
            <span aria-hidden="true" className="text-neutral-text-disabled">
              ⌕
            </span>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search ideas…"
              aria-label="Filter backlog ideas"
              className="flex-1 min-w-0 bg-transparent text-xs text-neutral-text-primary placeholder:text-neutral-text-secondary
                focus:outline-none"
            />
            {isFiltering && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="Clear backlog search"
                title="Clear search"
                // 16px glyph + invisible expander to the 44px touch target (rule 5).
                className="relative inline-flex items-center justify-center rounded-control text-neutral-text-disabled
                  hover:text-neutral-text-primary focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1
                  before:absolute before:inset-[-14px] before:content-['']"
                style={{ width: 16, height: 16, lineHeight: 0 }}
              >
                <span aria-hidden="true">×</span>
              </button>
            )}
            {onOpenCommandPalette && (
              <button
                type="button"
                onClick={onOpenCommandPalette}
                aria-label="Open command palette to search everything"
                title="Open command palette (⌘K)"
                className="tppm-mono text-xs text-neutral-text-disabled hover:text-neutral-text-primary
                  focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 rounded-control px-0.5"
              >
                ⌘K
              </button>
            )}
          </form>
        </div>
      )}

      {/* Hint — orientation copy for first-time users. */}
      <div className="px-4 pb-2.5 text-xs leading-snug text-neutral-text-secondary">
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
            className="flex-1 flex items-center justify-center rounded-card border border-dashed border-neutral-border text-xs italic text-neutral-text-secondary"
            role="status"
            style={{ minHeight: 88 }}
          >
            {canQuickCapture
              ? 'No backlog yet — capture an idea above, or drag a card here to defer it.'
              : 'No backlog yet — drag a card here to defer it.'}
          </div>
        ) : visibleTasks.length === 0 ? (
          <div
            className="flex-1 flex flex-col items-center justify-center gap-2 rounded-card border border-dashed border-neutral-border px-3 text-center text-xs italic text-neutral-text-secondary"
            role="status"
            style={{ minHeight: 88 }}
          >
            <span>No ideas match “{query.trim()}”.</span>
            <button
              type="button"
              onClick={() => setQuery('')}
              className="not-italic font-medium text-brand-primary hover:underline focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 rounded-control px-1"
            >
              Clear search
            </button>
          </div>
        ) : (
          visibleTasks.map((task) => {
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
                  onSchedule={onSchedule}
                />
              </div>
            );
          })
        )}

        {!readOnly && (
          <button
            type="button"
            onClick={onCaptureIdea}
            disabled={isCaptureIdeaPending || !onCaptureIdea}
            aria-busy={isCaptureIdeaPending}
            className="mt-1.5 flex items-center justify-center gap-1.5 rounded-control border border-dashed border-neutral-border bg-transparent text-xs text-neutral-text-disabled
              hover:border-brand-primary hover:text-brand-primary disabled:opacity-50 disabled:cursor-not-allowed
              focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
            style={{ height: 36 }}
          >
            <span aria-hidden="true" style={{ fontSize: 14, lineHeight: 0 }}>
              +
            </span>
            {isCaptureIdeaPending ? 'Adding…' : 'Add with details…'}
          </button>
        )}
      </div>
    </aside>
  );
}
