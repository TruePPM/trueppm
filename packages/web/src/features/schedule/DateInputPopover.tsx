/**
 * Modal dialog for precise date entry during keyboard reschedule (issue #34).
 *
 * Opens when the user presses 'd' in keyboard reschedule mode. Allows entering
 * a start date directly; finish date is derived from start + task duration
 * (calendar days) and shown as a read-only preview.
 *
 * Design rules:
 * - Rule 31 pattern: mounts at ScheduleView level (not inside CanvasScheduleTimeline) so it
 *   is not clipped by overflow:hidden on the timeline container.
 * - Rule 4: focus ring on all interactive elements.
 * - Rule 46: focus ring uses brand-primary (light surface dialog).
 * - WCAG 2.1.1: focus is moved to the first input on open and restored on close.
 */

import { useEffect, useRef, useState, useMemo, type FormEvent } from 'react';
import type { Task } from '@/types';

interface Props {
  /** Non-null when the popover is open. Null renders nothing. */
  task: Task | null;
  onConfirm: (newStart: string) => void;
  onClose: () => void;
}

export function DateInputPopover({ task, onConfirm, onClose }: Props) {
  const [startValue, setStartValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  // Keep track of the element that had focus before we opened the dialog
  const previousFocusRef = useRef<HTMLElement | null>(null);

  // Initialise input and capture focus when the popover opens
  useEffect(() => {
    if (!task) return;
    setStartValue(task.start.slice(0, 10));
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    // Defer focus so the dialog is painted before we move focus into it
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [task]);

  // Restore focus when the popover closes
  useEffect(() => {
    if (!task) {
      previousFocusRef.current?.focus();
    }
  }, [task]);

  // Capture-phase Escape so it fires before the keyboard reschedule handler
  useEffect(() => {
    if (!task) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [task, onClose]);

  // Derive finish date from entered start + task duration (calendar days)
  const derivedFinish = useMemo(() => {
    if (!task || !startValue) return '';
    // Guard: ensure startValue is a valid ISO date
    const parsed = new Date(startValue + 'T00:00:00Z');
    if (isNaN(parsed.getTime())) return '';
    parsed.setUTCDate(parsed.getUTCDate() + task.duration - 1);
    return parsed.toISOString().slice(0, 10);
  }, [startValue, task]);

  if (!task) return null;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!startValue || !derivedFinish) return;
    onConfirm(startValue);
  };

  return (
    // Wrapper
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Semi-transparent backdrop — clicking it closes the dialog (pointer-only;
          keyboard users use Escape or the Cancel button) */}
      <button
        type="button"
        aria-label="Close dialog"
        tabIndex={-1}
        className="absolute inset-0 bg-black/30 cursor-default"
        onClick={onClose}
      />

      {/* Dialog panel */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="date-popover-title"
        className="relative z-10 w-72 rounded border border-neutral-border bg-neutral-surface p-4 space-y-4"
      >
        <h2
          id="date-popover-title"
          className="text-sm font-semibold text-neutral-text-primary truncate"
          title={task.name}
        >
          Reschedule: {task.name}
        </h2>

        <form onSubmit={handleSubmit} className="space-y-3">
          {/* Start date input */}
          <div className="space-y-1">
            <label
              htmlFor="date-popover-start"
              className="block text-xs font-medium text-neutral-text-secondary"
            >
              Start date
            </label>
            <input
              ref={inputRef}
              id="date-popover-start"
              type="date"
              value={startValue}
              onChange={(e) => setStartValue(e.target.value)}
              className="w-full rounded border border-neutral-border bg-neutral-surface-raised px-2 py-1 text-sm text-neutral-text-primary
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            />
          </div>

          {/* Derived finish (read-only) */}
          <div className="space-y-1">
            <span className="block text-xs font-medium text-neutral-text-secondary">
              Finish (derived)
            </span>
            <p className="px-2 py-1 text-sm text-neutral-text-secondary bg-neutral-surface-raised rounded border border-neutral-border">
              {derivedFinish
                ? new Date(derivedFinish + 'T00:00:00Z').toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                  })
                : '—'}
            </p>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1 text-xs font-medium rounded border border-neutral-border text-neutral-text-secondary
                hover:bg-neutral-surface-raised
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!startValue || !derivedFinish}
              className="px-3 py-1 text-xs font-medium rounded bg-brand-primary text-white
                hover:bg-brand-primary-dark disabled:opacity-40 disabled:cursor-not-allowed
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              Confirm
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
