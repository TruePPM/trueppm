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
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useIsCoarsePointer } from '@/hooks/useIsCoarsePointer';
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
  /** Containers this idea can be filed into (#2952) — the board's phase lanes
   *  plus the project root. Empty on an assignee/epic-grouped board, where a
   *  lane id is not a WBS parent and there is nothing honest to file under. */
  fileUnderTargets?: FileUnderTarget[];
  /** Files the idea under `targetId` and lands it in To do — the keyboard and
   *  touch path for what the rail previously only offered as a drag. Omitted
   *  read-only, which removes the action rather than disabling it (rule 302). */
  onFileUnder?: (task: Task, targetId: string) => void;
  /** Below MEMBER (a Viewer) or on a closed sprint (#2680): disables the
   *  drag-to-promote gesture, mirroring `BoardCard`'s `readOnly` handling. The
   *  card stays click-to-open — only the drag activator is dropped. */
  readOnly?: boolean;
}

function ownerInitialsFromTask(task: Task): string | null {
  const first = task.assignees[0];
  if (!first) return null;
  const parts = first.name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2);
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * A container a backlog idea can be filed into — the phase lanes of the board
 * behind the rail, plus the project root.
 */
export interface FileUnderTarget {
  /** Lane id; `'root'` is the parentless project node. */
  id: string;
  name: string;
}

/**
 * The `···` overflow menu for a backlog card (#318 rule 135, extended #2952).
 *
 * Rendered as a sibling of the card's drag-source `<button>` (never nested —
 * an interactive control inside a button is invalid HTML and breaks the drag
 * activation). Positioned in the card's top-right.
 *
 * It used to be a single button that opened the Schedule dialog while
 * announcing itself as "Actions for …" with `aria-haspopup="dialog"`. It is a
 * real menu now because the rail gained a second action: **File under…**, the
 * keyboard and touch path for what the rail previously only described as a
 * drag. That hint — "drag right onto a phase" — was the whole promotion story
 * for an inbox whose entire job is catching an item with no place yet, and a
 * drag is unavailable to a keyboard user and awkward on a phone.
 *
 * `File under…` is the same move the drag performs (`dropOnCell`): re-parent
 * into the chosen container and land in **To do**. `Schedule…` is unchanged.
 */
function BacklogCardMenu({
  task,
  onSchedule,
  fileUnderTargets,
  onFileUnder,
}: {
  task: Task;
  onSchedule?: (task: Task, trigger: HTMLElement) => void;
  fileUnderTargets: FileUnderTarget[];
  onFileUnder?: (task: Task, targetId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [fileOpen, setFileOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const fileGroupId = useId();
  // Rule 5's 44px floor is set by the POINTER class, not the viewport (rule
  // 315): the rail is suppressed below `md:`, but a coarse-pointer tablet above
  // that breakpoint renders this desktop grid and gets these very targets.
  const coarse = useIsCoarsePointer();

  const canFileUnder = typeof onFileUnder === 'function' && fileUnderTargets.length > 0;

  // Focus the first item when the menu opens. Keyed on `open` alone so
  // expanding the File-under list does not yank focus back to the top.
  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setFileOpen(false);
      }
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  // Tabbing past the last item would otherwise leave the menu floating open
  // over the rail with focus somewhere else entirely.
  const onPanelBlur = useCallback((e: ReactFocusEvent<HTMLDivElement>) => {
    if (wrapRef.current?.contains(e.relatedTarget)) return;
    setOpen(false);
    setFileOpen(false);
  }, []);

  // Roving focus across every visible menuitem, including the expanded
  // File-under targets. Escape closes and returns focus to the trigger
  // (WCAG 2.1.1 menu pattern) — the same handler shape `CardOverflowMenu` uses.
  const onMenuKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      setOpen(false);
      setFileOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const items = Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    );
    if (items.length === 0) return;
    e.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLElement);
    let next: number;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    else if (e.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % items.length;
    else next = current <= 0 ? items.length - 1 : current - 1;
    items[next]?.focus();
  }, []);

  // Nothing to offer: render nothing rather than an empty menu. A Viewer gets
  // absence, not a disabled `···` (web rule 302) — and both actions in here
  // write, so for a Viewer BOTH callers pass `undefined` and this returns null.
  // `Schedule…` used to be gated on `projectId` alone, which left a read-only
  // rail with a live ··· whose one item fired a promote PATCH the server then
  // refused; the gutter's equivalent menu had already been gated (#2680).
  if (!canFileUnder && !onSchedule) return null;

  const itemClass =
    'w-full flex items-center text-left px-3 py-2 text-sm text-neutral-text-primary hover:bg-neutral-surface-raised focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-inset';
  // One owner for the number (rule 315(c)) — the hook, never a local ternary
  // over a hard-coded 44.
  const itemStyle = { minHeight: coarse ? 44 : 36 };

  return (
    <div ref={wrapRef} className="absolute top-1 right-1">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Actions for ${task.name}`}
        title="Actions"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
          setFileOpen(false);
        }}
        onKeyDown={(e) => {
          // The menu-button pattern opens on ↓/↑ as well as Enter/Space.
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
          e.preventDefault();
          e.stopPropagation();
          setOpen(true);
          setFileOpen(false);
        }}
        // 24px corner action + invisible expander to the 44px touch target
        // (rule 5); already position:absolute, so the pad anchors to the button.
        className="relative w-6 h-6 flex items-center justify-center rounded-control
          text-neutral-text-secondary hover:text-neutral-text-primary hover:bg-neutral-surface-raised
          focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1
          before:absolute before:inset-[-10px] before:content-['']"
      >
        <span aria-hidden="true" className="leading-none">
          ···
        </span>
      </button>

      {open && (
        <div
          ref={panelRef}
          role="menu"
          tabIndex={-1}
          aria-label={`Actions for ${task.name}`}
          onKeyDown={onMenuKeyDown}
          onBlur={onPanelBlur}
          onPointerDown={(e) => e.stopPropagation()}
          className="absolute right-0 top-7 z-20 min-w-[200px] rounded-card border border-neutral-border
            bg-neutral-surface py-1 focus:outline-none"
        >
          {canFileUnder && (
            <>
              <button
                type="button"
                role="menuitem"
                // A DISCLOSURE, not a submenu. `aria-haspopup="menu"` would
                // promise a `role="menu"` the user could enter with →, and this
                // opens a `role="group"` inside the same flat roving-focus list
                // — announcing "has submenu" and then not answering → is worse
                // than announcing an expander and behaving like one.
                aria-expanded={fileOpen}
                aria-controls={fileGroupId}
                className={itemClass}
                style={itemStyle}
                onClick={(e) => {
                  e.stopPropagation();
                  setFileOpen((v) => !v);
                }}
              >
                File under…
              </button>
              {fileOpen && (
                <div
                  id={fileGroupId}
                  role="group"
                  aria-label="File under"
                  // Bounded so a board with many phases cannot produce a list
                  // taller than the rail it opens inside.
                  className="py-0.5 max-h-60 overflow-y-auto"
                >
                  {fileUnderTargets.map((target) => (
                    <button
                      key={target.id}
                      type="button"
                      role="menuitem"
                      className={`${itemClass} pl-6 text-neutral-text-secondary`}
                      style={itemStyle}
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpen(false);
                        setFileOpen(false);
                        onFileUnder?.(task, target.id);
                      }}
                    >
                      {target.name}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
          {onSchedule && (
            <button
              type="button"
              role="menuitem"
              className={itemClass}
              style={itemStyle}
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                setFileOpen(false);
                onSchedule(task, triggerRef.current ?? e.currentTarget);
              }}
            >
              Schedule…
            </button>
          )}
        </div>
      )}
    </div>
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
  fileUnderTargets = [],
  onFileUnder,
  readOnly = false,
}: BacklogCardProps) {
  const initials = ownerInitialsFromTask(task);
  // Whether `BacklogCardMenu` will render anything — it returns null with no
  // actions to offer, and the card's reserved corner padding has to follow the
  // same condition or a menu-less card carries a gap for a button that isn't
  // there (and a menu-bearing one lets its title run under the ···).
  const hasMenu =
    Boolean(onSchedule) || (typeof onFileUnder === 'function' && fileUnderTargets.length > 0);
  const readiness: TaskReadiness = task.readiness ?? 'idea';
  const isIdeaTone = readiness === 'idea';
  const focusRing = isFocused ? 'ring-2 ring-brand-primary' : '';

  // Drag source — the card is grabbable into a phase column (BoardView's
  // handleDragEnd reads active.id == task.id). The pointer activation here
  // is what BoardCard uses too; dnd-kit owns pointerDown, so the focus
  // tracker rides on the React onFocus event instead of onPointerDown.
  //
  // `disabled: readOnly` closes the drag-to-promote path for a Viewer or a
  // closed sprint (#2680) — it was the one write path on this board that
  // didn't check `readOnly`, so a read-only user could still fire the status
  // PATCH by dragging a card out of the rail.
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.id,
    disabled: readOnly,
  });
  const dragOpacity = isDragging ? 'opacity-60' : '';

  // Mirrors `BoardCard` (#2146): dnd-kit clears `listeners` when disabled but
  // its `attributes` still carry `role="button"` + `aria-disabled="true"`,
  // which would make the card read as not-enabled to keyboard/AT users and to
  // Playwright even though it stays click-to-open. Drop the drag attributes
  // entirely when read-only instead of letting them announce a disabled state.
  const dragProps = readOnly ? {} : { ...attributes, ...listeners };

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
          {...dragProps}
          className={`flex w-full items-center gap-2 rounded-control border border-neutral-border bg-neutral-surface px-2.5 py-1.5 text-left focus:outline-none ${readOnly ? 'cursor-default' : 'cursor-grab'} ${hasMenu ? 'pr-7' : ''} ${focusRing} ${dragOpacity}`}
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
        <BacklogCardMenu
          task={task}
          onSchedule={onSchedule}
          fileUnderTargets={fileUnderTargets}
          onFileUnder={onFileUnder}
        />
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
        {...dragProps}
        className={`flex w-full flex-col gap-1.5 rounded-card border border-neutral-border bg-neutral-surface px-3 py-2.5 text-left focus:outline-none ${readOnly ? 'cursor-default' : 'cursor-grab'} ${focusRing} ${dragOpacity}`}
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
          <span className={hasMenu ? 'pr-6' : ''}>
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
      <BacklogCardMenu
        task={task}
        onSchedule={onSchedule}
        fileUnderTargets={fileUnderTargets}
        onFileUnder={onFileUnder}
      />
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
   *  rendered and the rail has no create path at all — the "Add with details…"
   *  modal it used to fall back to was deleted with #2952.
   *
   *  `opts.onError` is invoked if the create fails, so the rail can restore the
   *  typed idea it optimistically cleared (#2030) — a silent POST failure on a
   *  rapid-fire intake field otherwise loses the idea with no trace. */
  onQuickCapture?: (name: string, opts?: { onError?: () => void }) => void;
  /** True while a quick-capture create is in flight — disables the field. */
  isQuickCapturePending?: boolean;
  /** Containers a card can be filed into (#2952) — passed through to each
   *  card's `File under…` action. */
  fileUnderTargets?: FileUnderTarget[];
  /** Files a card under `targetId` and lands it in To do. Omitted read-only. */
  onFileUnder?: (task: Task, targetId: string) => void;
  /** Below MEMBER (a Viewer) or on a closed sprint (#2146): the rail is a
   *  read-only pile — the inline quick-capture field is suppressed, the
   *  `File under…` action is absent, and cards are no longer draggable (#2680;
   *  drag was the one write path that didn't check this flag). Cards remain
   *  openable — clicking one still opens the read-only detail view. */
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

/** "1 idea" / "4 ideas" — used by the rail's heading, aria-label and strip. */
function ideaCount(n: number): string {
  return `${n} ${n === 1 ? 'idea' : 'ideas'}`;
}

/**
 * Nothing in the backlog at all. The hint names quick capture only when the
 * user actually has it — a viewer is told the one thing they can do (drag).
 */
function EmptyBacklogHint({ canQuickCapture }: { canQuickCapture: boolean }) {
  return (
    <div
      className="flex-1 flex items-center justify-center rounded-card border border-dashed border-neutral-border text-xs italic text-neutral-text-secondary"
      role="status"
      style={{ minHeight: 88 }}
    >
      {canQuickCapture
        ? 'No backlog yet — capture an idea above, or drag a card here to defer it.'
        : 'No backlog yet — drag a card here to defer it.'}
    </div>
  );
}

/**
 * Backlog is non-empty but the live filter matched nothing. Distinct from
 * `EmptyBacklogHint` on purpose: filtering never hides how much backlog exists
 * (issue 1609), so this says "your search is empty", not "your backlog is".
 */
function NoBacklogMatchesHint({
  query,
  onClearSearch,
}: {
  query: string;
  onClearSearch: () => void;
}) {
  return (
    <div
      className="flex-1 flex flex-col items-center justify-center gap-2 rounded-card border border-dashed border-neutral-border px-3 text-center text-xs italic text-neutral-text-secondary"
      role="status"
      style={{ minHeight: 88 }}
    >
      <span>No ideas match “{query}”.</span>
      <button
        type="button"
        onClick={onClearSearch}
        className="not-italic font-medium text-brand-primary hover:underline focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 rounded-control px-1"
      >
        Clear search
      </button>
    </div>
  );
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
  fileUnderTargets = [],
  onFileUnder,
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
  // One predicate for the control AND for the sentence that describes it.
  const canFileUnder = !readOnly && typeof onFileUnder === 'function' && fileUnderTargets.length > 0;

  // Filing an idea moves it out of BACKLOG, so the card — and the ··· trigger
  // that had focus — unmounts. Without this, focus falls to `document.body` and
  // a keyboard user's next Tab restarts at the top of the document (WCAG 2.4.3).
  // The capture field is the honest landing place: it is where someone working
  // the inbox is heading next, and it is the one control the rail always keeps.
  const handleFileUnder = useCallback(
    (task: Task, targetId: string) => {
      onFileUnder?.(task, targetId);
      captureInputRef.current?.focus();
    },
    [onFileUnder],
  );
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
        aria-label={`Expand backlog rail, ${ideaCount(tasks.length)}`}
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
              aria-label={`${ideaCount(tasks.length)} in backlog`}
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
              // `readOnly`, not `disabled` — this field's contract is rapid
              // successive intake, and a disabled element is blurred by the
              // browser, which drops the caret (and, on touch, the soft
              // keyboard) between every idea. `submitCapture` already refuses
              // while pending, so nothing double-fires (#2952).
              readOnly={isQuickCapturePending}
              placeholder="Capture an idea…"
              aria-label="Capture a backlog idea"
              aria-keyshortcuts="Enter"
              className="flex-1 min-w-0 bg-transparent text-xs text-neutral-text-primary placeholder:text-neutral-text-secondary
                focus:outline-none read-only:cursor-progress"
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

      {/* Hint — orientation copy for first-time users.

          It used to name only the drag ("Drag right onto a phase to promote to
          To do"), which described the one path a keyboard user and a phone user
          could not take, on the surface whose entire job is getting an item out
          of the inbox. It names the action instead (#2952); the drag still
          works and is mentioned second, because it is the faster gesture for
          whoever has a pointer.

          It is derived from the SAME predicate as the control (`canFileUnder`),
          not rendered unconditionally: a read-only rail has neither path, and
          an assignee/epic-grouped board has no container to file into, so an
          unconditional sentence would name an action that is not in the menu —
          the rule-308 class arriving in copy instead of in a control. A viewer
          gets no promotion sentence at all, because they have no promotion. */}
      {!readOnly && (
        <div className="px-4 pb-2.5 text-xs leading-snug text-neutral-text-secondary">
          {canFileUnder ? (
            <>
              <strong className="font-semibold text-neutral-text-primary">File under…</strong> on a
              card promotes it to{' '}
              <strong className="font-semibold text-neutral-text-primary">To do</strong>. Dragging
              it right onto a phase does the same.
            </>
          ) : (
            <>
              Drag right onto a phase to promote to{' '}
              <strong className="font-semibold text-neutral-text-primary">To do</strong>.
            </>
          )}
        </div>
      )}

      {/* List — flex column with capture CTA pinned at the end. */}
      <div
        id="backlog-rail-body"
        className="flex-1 min-h-0 overflow-y-auto px-3 pb-4 pt-1 flex flex-col gap-1.5"
        role="list"
        aria-label="Backlog cards"
      >
        {sortedTasks.length === 0 ? (
          <EmptyBacklogHint canQuickCapture={canQuickCapture} />
        ) : visibleTasks.length === 0 ? (
          <NoBacklogMatchesHint query={query.trim()} onClearSearch={() => setQuery('')} />
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
                  // Both write, so both are dropped read-only here as well as
                  // at the caller — one layer failing open must not be enough.
                  onSchedule={readOnly ? undefined : onSchedule}
                  fileUnderTargets={fileUnderTargets}
                  onFileUnder={canFileUnder ? handleFileUnder : undefined}
                  readOnly={readOnly}
                />
              </div>
            );
          })
        )}

        {/* "Add with details…" is gone (#2952). It opened `TaskFormModal` with a
            BACKLOG default — a second, richer creation form sitting directly
            under a field that already captures. The inbox catches an item that
            has no place yet; a description, an assignee and a date are answers
            it does not have. They are one tap away in the drawer on the card
            that now exists, which is the same trade the shell's "+ New task"
            demotion made (#2031). */}
      </div>
    </aside>
  );
}
