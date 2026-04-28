import React, { useState, useRef, useCallback, useId } from 'react';
import type { Task } from '@/types';

interface UnscheduledTaskRowProps {
  task: Task;
  onDragStart: (task: Task, pointerId: number, x: number, y: number) => void;
  onSetDate: (task: Task, date: string) => void;
}

/**
 * A single row in the unscheduled gutter.
 *
 * Supports drag-to-promote via Pointer Events API (4px threshold, rule 64/66)
 * and a keyboard alternative via the ··· overflow menu (rule 105 pattern).
 */
export function UnscheduledTaskRow({ task, onDragStart, onSetDate }: UnscheduledTaskRowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [dateInput, setDateInput] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const dateInputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();

  const startX = useRef<number>(0);
  const startY = useRef<number>(0);
  const dragStarted = useRef<boolean>(false);
  const pointerId = useRef<number>(0);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
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
    setMenuOpen((v) => {
      const next = !v;
      if (next) {
        // Focus the date input after the menu mounts
        setTimeout(() => dateInputRef.current?.focus(), 0);
      }
      return next;
    });
  }, []);

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
      className="relative flex items-center gap-3 px-4 h-9 border-b border-neutral-border/40
        cursor-grab hover:bg-neutral-surface-raised select-none
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-inset"
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

      {/* Task name */}
      <span className="text-sm text-neutral-text-primary flex-1 truncate min-w-0">
        {task.name}
      </span>

      {/* Duration */}
      <span className="tppm-mono text-xs text-neutral-text-secondary shrink-0">
        {task.duration}d
      </span>

      {/* Overflow menu — keyboard path to set planned start (rule 105 pattern) */}
      <div className="relative shrink-0" ref={menuRef}>
        <button
          type="button"
          aria-label={`Actions for ${task.name}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          className="w-6 h-6 flex items-center justify-center rounded text-neutral-text-secondary
            hover:text-neutral-text-primary hover:bg-neutral-surface-raised
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          onClick={handleMenuOpen}
        >
          ···
        </button>

        {menuOpen && (
          <div
            role="menu"
            tabIndex={-1}
            onKeyDown={handleMenuKeyDown}
            className="absolute right-0 bottom-8 z-30 bg-neutral-surface border border-neutral-border
              rounded py-2 min-w-[200px]"
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
                className="h-8 rounded border border-neutral-border px-2 text-sm
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
              />
              <button
                type="submit"
                disabled={!dateInput}
                className="h-7 rounded border border-neutral-border text-xs font-medium
                  disabled:opacity-40 hover:border-brand-primary hover:text-brand-primary
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
              >
                Promote to schedule
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
