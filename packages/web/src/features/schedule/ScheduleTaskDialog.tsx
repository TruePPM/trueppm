import { useCallback, useEffect, useId, useRef, useState, type RefObject } from 'react';
import type { Task } from '@/types';
import { usePromoteTask } from '@/hooks/useTaskMutations';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import { useScheduleStore } from '@/stores/scheduleStore';
import { formatShortDate } from './scheduleUtils';

interface ScheduleTaskDialogProps {
  /** The backlog task being scheduled. */
  task: Task;
  /** Project UUID — used for the promote PATCH + cache invalidation. */
  projectId: string;
  /**
   * DOM ref to the aria-live (polite) region to announce the result. Optional:
   * the gutter passes its existing region; the Board has no schedule canvas
   * aria-live region, so it falls back to the schedule action toast only.
   */
  ariaLiveRef?: RefObject<HTMLDivElement | null>;
  /**
   * Sprint to assign in the same promote PATCH. Set by the Board when it is
   * scoped to a PLANNED/ACTIVE sprint, so a keyboard-promoted backlog card is
   * pulled into that sprint — the WCAG 2.1.1 keyboard parallel to dragging a
   * card into a phase cell (#2170, #429). Omitted by the Schedule gutter, where
   * there is no sprint scope, so that path is unchanged.
   */
  assignSprint?: { id: string; name: string; pending: boolean } | null;
  /** Close the dialog and return focus to the trigger (handled by caller). */
  onClose: () => void;
}

/** Local-time ISO `YYYY-MM-DD` for today — the date input's default value. */
function todayLocalIso(): string {
  const now = new Date();
  const offsetMs = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offsetMs).toISOString().slice(0, 10);
}

/**
 * Keyboard alternative for promoting a BACKLOG item onto the schedule (#318,
 * rule 135 — the WCAG 2.1.1 keyboard parallel to the gutter/Board drag).
 *
 * One shared dialog, two entry points: the gutter backlog chip's `···` menu
 * and the Board `BacklogCard`'s `···` action. Both issue the identical promote
 * PATCH `{ planned_start, status: 'NOT_STARTED' }` (decision A2) via
 * {@link usePromoteTask}, so a backlog idea lands deterministically in To Do
 * regardless of the chosen date.
 *
 * Focus-first on the date input, focus-trapped, Esc + ✕ cancel and return focus
 * to the trigger — mirrors `BacklogDemoteConfirmDialog`'s pattern.
 */
export function ScheduleTaskDialog({
  task,
  projectId,
  ariaLiveRef,
  assignSprint,
  onClose,
}: ScheduleTaskDialogProps) {
  const itl = useIterationLabel();
  const promote = usePromoteTask();
  const setActionToast = useScheduleStore((s) => s.setScheduleActionToast);

  const [date, setDate] = useState<string>(() => todayLocalIso());
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState<boolean>(() => !navigator.onLine);

  const dialogRef = useRef<HTMLDivElement>(null);
  const dateInputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const helperId = useId();
  const dateInputId = useId();

  // Focus the date input on open (focus-first, rule 135).
  useEffect(() => {
    dateInputRef.current?.focus();
  }, []);

  // Track online/offline so the Schedule button reflects connectivity (rule 29).
  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  // Esc closes + returns focus to the trigger (caller owns focus return).
  // Tab/Shift+Tab are trapped inside the dialog.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === 'Tab') {
        const root = dialogRef.current;
        if (!root) return;
        const focusable = root.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  const handleSchedule = useCallback(() => {
    if (!date) return;
    if (!navigator.onLine) {
      setOffline(true);
      return;
    }
    setError(null);
    // Decision A2: explicit status: 'NOT_STARTED' skips the server's date-gated
    // → IN_PROGRESS auto-bump, so the promotion is deterministically To Do.
    // When the Board is scoped to a sprint (#2170) the same PATCH assigns that
    // sprint, so the promoted card is pulled into the sprint rather than landing
    // committed-but-unscoped (and hidden from the sprint board).
    promote.mutate(
      {
        id: task.id,
        projectId,
        planned_start: date,
        status: 'NOT_STARTED',
        ...(assignSprint ? { sprint: assignSprint.id } : {}),
      },
      {
        onSuccess: () => {
          const label = formatShortDate(date);
          const dest = assignSprint ? assignSprint.name : `the ${itl.lower}`;
          // An ACTIVE sprint injects the card as pending scope (ADR-0102),
          // mirroring the drag-drop notice copy (#1140).
          const pendingNote = assignSprint?.pending ? ' as pending scope' : '';
          setActionToast({
            message: `Added '${task.name}' to ${dest}${pendingNote}, starting ${label}`,
          });
          if (ariaLiveRef?.current) {
            ariaLiveRef.current.textContent = `Added ${task.name} to ${dest}${pendingNote}, starting ${label}.`;
          }
          onClose();
        },
        onError: () => {
          // Keep the dialog open with an inline error so the user can retry.
          setError(`Couldn't add this item to the ${itl.lower}. Try again.`);
        },
      },
    );
  }, [
    date,
    task.id,
    task.name,
    projectId,
    promote,
    setActionToast,
    ariaLiveRef,
    assignSprint,
    onClose,
    itl.lower,
  ]);

  const scheduleDisabled = !date || offline || promote.isPending;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-neutral-overlay" aria-hidden="true" onClick={onClose} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={helperId}
        className="relative z-10 w-[360px] max-w-[calc(100vw-2rem)] rounded-card
          bg-neutral-surface border border-neutral-border p-5"
      >
        {/* Title + close (44×44, rule 5) */}
        <div className="flex items-start gap-2 mb-1">
          <h2
            id={titleId}
            className="flex-1 min-w-0 text-sm font-semibold text-neutral-text-primary truncate"
          >
            Add &ldquo;{task.name}&rdquo; to {assignSprint ? assignSprint.name : `a ${itl.lower}`}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cancel"
            className="-mr-2 -mt-2 w-11 h-11 flex items-center justify-center rounded-control
              text-neutral-text-secondary hover:text-neutral-text-primary
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            <span aria-hidden="true" className="text-base leading-none">
              ✕
            </span>
          </button>
        </div>

        <p id={helperId} className="text-xs text-neutral-text-secondary mb-4">
          This commits the idea from your backlog to{' '}
          {assignSprint ? assignSprint.name : `a ${itl.lower}`}
          {assignSprint?.pending ? ' as pending scope' : ''}, starting on the target date you pick
          below.
        </p>

        <label
          htmlFor={dateInputId}
          className="block text-xs font-medium text-neutral-text-secondary mb-1.5"
        >
          Target date
        </label>
        <input
          ref={dateInputRef}
          id={dateInputId}
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="w-full h-9 rounded-control border border-neutral-border px-2.5 text-sm
            text-neutral-text-primary bg-neutral-surface
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        />

        {error && (
          <p role="alert" className="mt-2 text-xs text-semantic-critical">
            {error}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="border border-neutral-border rounded-control h-8 px-4 text-xs font-medium text-neutral-text-primary
              hover:bg-neutral-surface-raised
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSchedule}
            disabled={scheduleDisabled}
            title={offline ? "You're offline — change not saved." : undefined}
            className="rounded-control h-8 px-4 text-xs font-medium bg-brand-primary text-neutral-text-inverse
              disabled:opacity-40 disabled:cursor-not-allowed
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            {promote.isPending ? 'Adding…' : `Add to ${itl.lower}`}
          </button>
        </div>
      </div>
    </div>
  );
}
