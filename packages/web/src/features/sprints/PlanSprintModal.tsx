import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useSprintMutations } from '@/hooks/useSprints';

interface Props {
  projectId: string;
  /** Suggested start date in ISO form — defaults to today. */
  defaultStart?: string;
  onClose: () => void;
  /** Called after the sprint is created. Closes the modal automatically. */
  onCreated?: (sprintId: string) => void;
}

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Minimal "Plan sprint" modal — name, window, optional goal.
 *
 * Calls `POST /api/v1/projects/{projectId}/sprints/` via the existing
 * `useSprintMutations().createSprint` mutation. Sprints land in
 * `PLANNED` state; the user activates them later from the timeline strip.
 *
 * v1 deliberately omits the milestone picker and capacity preflight —
 * those are wave/10 follow-ups attached to a richer wizard. The single
 * dialog is enough to unblock manual sprint creation today.
 */
export function PlanSprintModal({
  projectId,
  defaultStart,
  onClose,
  onCreated,
}: Props) {
  const initialStart = defaultStart ?? todayIso();
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [startDate, setStartDate] = useState(initialStart);
  const [finishDate, setFinishDate] = useState(addDaysIso(initialStart, 13));

  const dialogRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<Element | null>(null);

  const { createSprint } = useSprintMutations(projectId);

  // Capture trigger before opening; restore focus on unmount.
  useEffect(() => {
    triggerRef.current = document.activeElement;
    nameRef.current?.focus();
    return () => {
      if (triggerRef.current instanceof HTMLElement) triggerRef.current.focus();
    };
  }, []);

  // Escape closes; Tab cycles within the dialog.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const focusable = getFocusable(dialogRef.current);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const trimmedName = name.trim();
  const datesValid =
    startDate.length > 0 &&
    finishDate.length > 0 &&
    finishDate > startDate;
  const canSubmit = trimmedName.length > 0 && datesValid && !createSprint.isPending;

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    createSprint.mutate(
      {
        name: trimmedName,
        goal: goal.trim() || undefined,
        start_date: startDate,
        finish_date: finishDate,
      },
      {
        onSuccess: (data) => {
          onCreated?.(data.id);
          onClose();
        },
      },
    );
  }

  return (
    <>
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close dialog"
        className="fixed inset-0 z-50 bg-black/40 cursor-default"
        onClick={onClose}
      />
      <div className="fixed inset-0 z-[51] flex items-center justify-center p-4 pointer-events-none">
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label="Plan next sprint"
          className="w-full max-w-md rounded-lg border border-neutral-border bg-neutral-surface p-6 pointer-events-auto"
        >
          <h2 className="text-base font-semibold text-neutral-text-primary mb-4">
            Plan next sprint
          </h2>

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-neutral-text-secondary">
                Name <span aria-hidden="true">*</span>
              </span>
              <input
                ref={nameRef}
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={255}
                required
                aria-required="true"
                placeholder="Sprint 13 — Pilot deployment"
                className="h-9 px-3 rounded border border-neutral-border bg-neutral-surface
                  text-sm text-neutral-text-primary placeholder:text-neutral-text-disabled
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              />
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-neutral-text-secondary">
                  Start <span aria-hidden="true">*</span>
                </span>
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  required
                  aria-required="true"
                  className="h-9 px-3 rounded border border-neutral-border bg-neutral-surface
                    text-sm text-neutral-text-primary tppm-mono
                    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-neutral-text-secondary">
                  Finish <span aria-hidden="true">*</span>
                </span>
                <input
                  type="date"
                  value={finishDate}
                  onChange={(e) => setFinishDate(e.target.value)}
                  required
                  aria-required="true"
                  className="h-9 px-3 rounded border border-neutral-border bg-neutral-surface
                    text-sm text-neutral-text-primary tppm-mono
                    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
                />
              </label>
            </div>
            {!datesValid && (startDate.length > 0 && finishDate.length > 0) && (
              <p role="alert" className="text-xs text-semantic-critical">
                Finish date must be after start date.
              </p>
            )}

            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-neutral-text-secondary">
                Goal
              </span>
              <textarea
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                rows={3}
                maxLength={1000}
                placeholder="What does this sprint deliver?"
                className="px-3 py-2 rounded border border-neutral-border bg-neutral-surface
                  text-sm text-neutral-text-primary placeholder:text-neutral-text-disabled resize-none
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              />
            </label>

            {createSprint.isError && (
              <p role="alert" className="text-xs text-semantic-critical">
                Failed to create sprint. Please try again.
              </p>
            )}

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={onClose}
                disabled={createSprint.isPending}
                className="h-9 px-4 rounded text-sm font-medium border border-neutral-border
                  text-neutral-text-secondary hover:text-neutral-text-primary
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!canSubmit}
                className="h-9 px-4 rounded text-sm font-medium bg-brand-primary text-white
                  disabled:opacity-50 disabled:cursor-not-allowed hover:bg-brand-primary-dark
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white
                  focus-visible:ring-offset-2 focus-visible:ring-offset-brand-primary"
              >
                {createSprint.isPending ? 'Creating…' : 'Plan sprint'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </>
  );
}
