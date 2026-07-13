import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useSprintMutations } from '@/hooks/useSprints';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import { UnsavedChangesDialog, useUnsavedChangesGuard } from '@/components/dialog';

export interface ExistingSprintForEdit {
  id: string;
  name: string;
  goal?: string;
  start_date: string;
  finish_date: string;
}

interface Props {
  projectId: string;
  /** Suggested start date in ISO form — defaults to today. Ignored in edit mode. */
  defaultStart?: string;
  onClose: () => void;
  /** Called after the sprint is created. Closes the modal automatically. */
  onCreated?: (sprintId: string) => void;
  /** When set, the modal opens in edit mode and PATCHes this sprint
   *  instead of creating a new one (issue #299). */
  existingSprint?: ExistingSprintForEdit;
  /** Optional callback after a successful edit. */
  onUpdated?: (sprintId: string) => void;
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
  existingSprint,
  onUpdated,
}: Props) {
  const itl = useIterationLabel(projectId);
  const isEdit = existingSprint !== undefined;
  const initialStart = existingSprint?.start_date ?? defaultStart ?? todayIso();
  const initialFinish = existingSprint?.finish_date ?? addDaysIso(initialStart, 13);
  const initialName = existingSprint?.name ?? '';
  const initialGoal = existingSprint?.goal ?? '';
  const [name, setName] = useState(initialName);
  const [goal, setGoal] = useState(initialGoal);
  const [startDate, setStartDate] = useState(initialStart);
  const [finishDate, setFinishDate] = useState(initialFinish);

  const dialogRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<Element | null>(null);

  const { createSprint, updateSprint } = useSprintMutations(projectId);
  const activeMutation = isEdit ? updateSprint : createSprint;

  // Capture trigger before opening; restore focus on unmount.
  useEffect(() => {
    triggerRef.current = document.activeElement;
    nameRef.current?.focus();
    return () => {
      if (triggerRef.current instanceof HTMLElement) triggerRef.current.focus();
    };
  }, []);

  // Dirty check — by-value comparison against the values the modal opened
  // with (issue #1913, matching web-rule 217's dismiss-guard contract).
  const isDirty =
    name !== initialName ||
    goal !== initialGoal ||
    startDate !== initialStart ||
    finishDate !== initialFinish;

  // Dismiss-guard: Escape / scrim / Cancel route through requestClose, which
  // opens the styled, focus-trapped UnsavedChangesDialog when dirty instead of
  // silently discarding the draft sprint (issue #1913). The guard owns its own
  // Escape listener, so the Tab-cycling effect below no longer handles Escape.
  const { requestClose, guardOpen, keepEditing, discard } = useUnsavedChangesGuard({
    dirty: isDirty,
    onClose,
  });

  // Tab cycles within the dialog. Suspended while the discard prompt is open
  // so its own focus trap (UnsavedChangesDialog) doesn't fight this one for
  // the same Tab cycle.
  useEffect(() => {
    if (guardOpen) return undefined;
    const handler = (e: KeyboardEvent) => {
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
  }, [guardOpen]);

  const trimmedName = name.trim();
  const datesValid =
    startDate.length > 0 &&
    finishDate.length > 0 &&
    finishDate > startDate;
  const canSubmit = trimmedName.length > 0 && datesValid && !activeMutation.isPending;

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    if (isEdit && existingSprint) {
      updateSprint.mutate(
        {
          sprintId: existingSprint.id,
          payload: {
            name: trimmedName,
            goal: goal.trim(),
            start_date: startDate,
            finish_date: finishDate,
          },
        },
        {
          onSuccess: (data) => {
            onUpdated?.(data.id);
            onClose();
          },
        },
      );
      return;
    }
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
      {/* Backdrop — click-to-close but never a Tab stop (tabIndex=-1), so the
          first Tab lands on a control inside the dialog, not this invisible
          full-screen button (issue 1357). */}
      <button
        type="button"
        aria-label="Close dialog"
        tabIndex={-1}
        className="fixed inset-0 z-50 bg-neutral-overlay cursor-default"
        onClick={requestClose}
      />
      <div className="fixed inset-0 z-[51] flex items-center justify-center p-4 pointer-events-none">
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label={isEdit ? `Edit planned ${itl.lower}` : `Plan next ${itl.lower}`}
          className="w-full max-w-md rounded-card border border-neutral-border bg-neutral-surface p-6 pointer-events-auto"
        >
          <h2 className="text-base font-semibold text-neutral-text-primary mb-4">
            {isEdit ? `Edit planned ${itl.lower}` : `Plan next ${itl.lower}`}
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
                placeholder={`${itl.singular} 13 — Pilot deployment`}
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
                placeholder={`What does this ${itl.lower} deliver?`}
                className="px-3 py-2 rounded border border-neutral-border bg-neutral-surface
                  text-sm text-neutral-text-primary placeholder:text-neutral-text-disabled resize-none
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              />
            </label>

            {activeMutation.isError && (
              <p role="alert" className="text-xs text-semantic-critical">
                {isEdit
                  ? `Failed to update ${itl.lower}. Please try again.`
                  : `Failed to create ${itl.lower}. Please try again.`}
              </p>
            )}

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={requestClose}
                disabled={activeMutation.isPending}
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
                {activeMutation.isPending
                  ? isEdit
                    ? 'Saving…'
                    : 'Creating…'
                  : isEdit
                    ? 'Save changes'
                    : `Plan ${itl.lower}`}
              </button>
            </div>
          </form>
        </div>
      </div>
      {guardOpen && <UnsavedChangesDialog onKeepEditing={keepEditing} onDiscard={discard} />}
    </>
  );
}
