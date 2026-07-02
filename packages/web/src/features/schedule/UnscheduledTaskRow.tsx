import React, { useState, useRef, useCallback, useId, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import type { Task, TaskReadiness } from '@/types';

export type UnscheduledRowVariant = 'todo' | 'backlog';

interface UnscheduledTaskRowProps {
  task: Task;
  /** `todo` (NOT_STARTED, default) or `backlog` (status === 'BACKLOG'). The
   *  backlog variant carries a dashed left edge + readiness label and routes
   *  its `···` menu to the shared ScheduleTaskDialog instead of an inline form
   *  (#318). */
  variant?: UnscheduledRowVariant;
  onDragStart: (task: Task, pointerId: number, x: number, y: number) => void;
  /** To Do path — inline "set planned start" form (existing behavior). */
  onSetDate: (task: Task, date: string) => void;
  /** Backlog path — open the shared ScheduleTaskDialog. The row passes its own
   *  `···` button as the trigger so focus can be returned on close. */
  onScheduleRequest?: (task: Task, trigger: HTMLElement) => void;
}

/**
 * Inline readiness label for a backlog chip (#318, rule 133). The text label is
 * the non-color signal that a drop PROMOTES (BACKLOG → To Do); the dashed left
 * edge on the row is the at-a-glance cue. Mirrors the BacklogBand ReadinessChip
 * semantics (idea / estimated / ready / baselined).
 */
function ReadinessLabel({ readiness }: { readiness: TaskReadiness }) {
  const tone: Record<TaskReadiness, string> = {
    idea: 'border border-dashed border-neutral-border text-neutral-text-disabled',
    estimated: 'bg-neutral-surface-sunken text-neutral-text-secondary',
    ready: 'text-brand-primary',
    baselined: 'bg-neutral-surface-sunken text-neutral-text-secondary',
  };
  return (
    <span
      className={`inline-flex items-center rounded-chip uppercase tracking-wider font-semibold shrink-0 px-1.5 ${tone[readiness]}`}
      style={{ height: 16, fontSize: '10px', letterSpacing: '0.06em' }}
    >
      {readiness}
    </span>
  );
}

/**
 * A single row in the unscheduled gutter (#213, extended for #318).
 *
 * Supports drag-to-promote via Pointer Events API (4px threshold, rule 64/66)
 * and a keyboard alternative via the ··· overflow menu (rule 105 pattern):
 *   - `todo` variant: inline "set planned start" form (existing path).
 *   - `backlog` variant: a "Schedule…" item that opens the shared
 *     ScheduleTaskDialog (rule 135) — the keyboard parallel to dragging the
 *     dashed chip onto the timeline.
 */
export function UnscheduledTaskRow({
  task,
  variant = 'todo',
  onDragStart,
  onSetDate,
  onScheduleRequest,
}: UnscheduledTaskRowProps) {
  const isBacklog = variant === 'backlog';
  const readiness: TaskReadiness = task.readiness ?? 'idea';
  const isIdeaTone = isBacklog && readiness === 'idea';

  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [dateInput, setDateInput] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const dateInputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();

  const startX = useRef<number>(0);
  const startY = useRef<number>(0);
  const dragStarted = useRef<boolean>(false);
  const pointerId = useRef<number>(0);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    // Don't start a drag if the pointer-down originated on the overflow button
    // or inside the (portaled) menu. setPointerCapture on the row would otherwise
    // redirect the pointerup away from the button and swallow its click event.
    if (buttonRef.current?.contains(e.target as Node)) return;
    if (menuRef.current?.contains(e.target as Node)) return;
    startX.current = e.clientX;
    startY.current = e.clientY;
    dragStarted.current = false;
    pointerId.current = e.pointerId;
    rowRef.current?.setPointerCapture(e.pointerId);
    e.currentTarget.addEventListener('pointermove', handlePointerMove as unknown as EventListener, { once: false });
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  const handlePointerMove = useCallback((e: PointerEvent) => {
    if (dragStarted.current) return;
    const dx = e.clientX - startX.current;
    const dy = e.clientY - startY.current;
    if (Math.sqrt(dx * dx + dy * dy) >= 4) {
      dragStarted.current = true;
      rowRef.current?.releasePointerCapture(pointerId.current);
      onDragStart(task, pointerId.current, e.clientX, e.clientY);
    }
  }, [task, onDragStart]);

  const handlePointerUp = useCallback(() => {
    dragStarted.current = false;
  }, []);

  const handleMenuKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') setMenuOpen(false);
  }, []);

  const handleMenuOpen = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    // Backlog rows open the shared ScheduleTaskDialog directly (no inline form);
    // the dialog owns focus-first + focus-return, so pass our ··· button as the
    // trigger and don't toggle the inline menu.
    if (isBacklog) {
      if (buttonRef.current) onScheduleRequest?.(task, buttonRef.current);
      return;
    }
    setMenuOpen((v) => {
      const next = !v;
      if (next) {
        // Focus the date input after the menu mounts
        setTimeout(() => dateInputRef.current?.focus(), 0);
      }
      return next;
    });
  }, [isBacklog, onScheduleRequest, task]);

  // Position the portaled menu above the overflow button (escapes scroll-container clipping).
  useLayoutEffect(() => {
    if (!menuOpen || !buttonRef.current) {
      setMenuPos(null);
      return;
    }
    const rect = buttonRef.current.getBoundingClientRect();
    const MENU_WIDTH = 200;
    const MENU_HEIGHT = 110;
    setMenuPos({
      top: rect.top - MENU_HEIGHT - 4,
      left: rect.right - MENU_WIDTH,
    });
  }, [menuOpen]);

  // Close the menu on outside click.
  React.useEffect(() => {
    if (!menuOpen) return;
    function onDocPointerDown(e: PointerEvent) {
      const target = e.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (buttonRef.current?.contains(target)) return;
      setMenuOpen(false);
    }
    document.addEventListener('pointerdown', onDocPointerDown);
    return () => document.removeEventListener('pointerdown', onDocPointerDown);
  }, [menuOpen]);

  const handleDateSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    if (dateInput) {
      onSetDate(task, dateInput);
      setMenuOpen(false);
      setDateInput('');
    }
  }, [dateInput, task, onSetDate]);

  return (
    <div
      ref={rowRef}
      className={`relative flex items-center gap-3 px-4 h-9 border-b border-neutral-border/40
        cursor-grab hover:bg-neutral-surface-raised select-none
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-inset
        ${isBacklog ? 'border-l-2 border-dashed border-neutral-border' : ''}`}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      style={{ touchAction: 'none' }}
    >
      {/* Drag handle indicator */}
      <span className="text-neutral-text-disabled text-xs shrink-0" aria-hidden="true">⋮⋮</span>

      {/* WBS short_id */}
      <span className="tppm-mono text-xs text-neutral-text-secondary w-14 truncate shrink-0">
        {task.wbs || '—'}
      </span>

      {/* Backlog readiness label — the non-color promote cue (rule 133) */}
      {isBacklog && <ReadinessLabel readiness={readiness} />}

      {/* Task name — idea-readiness backlog rows render italic + secondary */}
      <span
        className={`text-sm flex-1 truncate min-w-0 ${
          isIdeaTone ? 'italic text-neutral-text-secondary' : 'text-neutral-text-primary'
        }`}
      >
        {task.name}
      </span>

      {/* Duration */}
      <span className="tppm-mono text-xs text-neutral-text-secondary shrink-0">
        {task.duration}d
      </span>

      {/* Overflow menu — keyboard path (rule 105 pattern).
          To Do: inline "set planned start" form, portaled to body to escape the
          scroll container's overflow clip. Backlog: opens ScheduleTaskDialog. */}
      <div className="shrink-0">
        <button
          ref={buttonRef}
          type="button"
          aria-label={`Actions for ${task.name}`}
          aria-haspopup={isBacklog ? 'dialog' : 'menu'}
          aria-expanded={isBacklog ? undefined : menuOpen}
          className="w-6 h-6 flex items-center justify-center rounded-control text-neutral-text-secondary
            hover:text-neutral-text-primary hover:bg-neutral-surface-raised
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          onClick={handleMenuOpen}
        >
          ···
        </button>
      </div>

      {!isBacklog && menuOpen && menuPos && createPortal(
        <div
          ref={menuRef}
          role="menu"
          tabIndex={-1}
          onKeyDown={handleMenuKeyDown}
          style={{ position: 'fixed', top: menuPos.top, left: menuPos.left, width: 200 }}
          className="z-50 bg-neutral-surface border border-neutral-border rounded-card py-2"
        >
          <form onSubmit={handleDateSubmit} className="px-3 py-2 flex flex-col gap-2">
            <label
              htmlFor={inputId}
              className="text-xs text-neutral-text-secondary font-medium"
            >
              Set planned start
            </label>
            <input
              ref={dateInputRef}
              id={inputId}
              type="date"
              value={dateInput}
              onChange={(e) => setDateInput(e.target.value)}
              className="h-8 rounded-control border border-neutral-border px-2 text-sm
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
            />
            <button
              type="submit"
              disabled={!dateInput}
              className="h-7 rounded-control border border-neutral-border text-xs font-medium
                disabled:opacity-40 hover:border-brand-primary hover:text-brand-primary
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
            >
              Promote to schedule
            </button>
          </form>
        </div>,
        document.body,
      )}
    </div>
  );
}
