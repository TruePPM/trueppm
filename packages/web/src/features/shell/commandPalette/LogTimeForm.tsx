import { useEffect, useId, useRef, useState, type FormEvent } from 'react';

import { AxiosError } from 'axios';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { clearLastTask } from '@/lib/lastTask';
import { useCreateTimeEntry } from '@/hooks/useCreateTimeEntry';
import { localTodayIso } from '@/lib/localDate';
import { describeWriteRefusal } from '@/lib/writeRefusal';
import { formatLoggedMinutes } from '@/lib/formatElapsed';
import { parseDurationToMinutes } from '@/features/timeentry/durationInput';
import type { LogTimeTarget } from '@/stores/commandPaletteStore';

interface Props {
  target: LogTimeTarget;
  /** Return to the result list (the palette stays open). */
  onBack: () => void;
  /** Close the whole palette after a successful log. */
  onDone: () => void;
}

/**
 * Inline minutes form for the "Log time on <last task>" palette action (#1211).
 *
 * Replaces the palette body so the user logs without leaving it. A bare integer is
 * minutes (`45`), a decimal is hours (`1.5`), `h:mm` is a clock duration — the same
 * parser as the TopBar quick-log. Success closes the palette and the shared hook
 * raises the success + Undo toast. A refusal stays inline as a sibling `role="alert"`
 * (rule 372) carrying the server's own reason, and the form stays open for a retry.
 */
export function LogTimeForm({ target, onBack, onDone }: Props) {
  const create = useCreateTimeEntry({ toastErrors: false });
  const { user } = useCurrentUser();
  const headingId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [raw, setRaw] = useState('');
  const [touchedInvalid, setTouchedInvalid] = useState(false);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const minutes = parseDurationToMinutes(raw);
  const refusal = describeWriteRefusal(create.error, 'Could not log time. Please try again.');

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (create.isPending) return;
    if (minutes === null) {
      setTouchedInvalid(true);
      return;
    }
    create.mutate(
      {
        taskId: target.taskId,
        taskLabel: target.taskLabel,
        minutes,
        entryDate: localTodayIso(),
      },
      {
        onSuccess: onDone,
        onError: (error) => {
          // 404: the task or project is gone, so the remembered target is dead —
          // forget it so the action stops being offered. A 403 (archived project,
          // lost membership) may be reversible, so it keeps the target and shows
          // the refusal.
          if (user?.id && error instanceof AxiosError && error.response?.status === 404) {
            clearLastTask(user.id, target.taskId);
          }
        },
      },
    );
  }

  const showInvalid = touchedInvalid && minutes === null;

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3 p-4" data-testid="cmdk-log-time">
      <p id={headingId} className="text-sm font-medium text-neutral-text-primary">
        Log time on <span className="break-words">{target.taskLabel}</span>
      </p>
      <label className="flex flex-col gap-1 text-xs text-neutral-text-secondary">
        Minutes (or 1.5 for hours, 1:30)
        <input
          ref={inputRef}
          type="text"
          inputMode="text"
          value={raw}
          onChange={(e) => {
            setRaw(e.target.value);
            setTouchedInvalid(false);
            create.reset();
          }}
          placeholder="e.g. 45"
          aria-invalid={showInvalid}
          aria-describedby={showInvalid ? `${headingId}-err` : undefined}
          className="h-11 md:h-9 rounded-control border border-neutral-border bg-neutral-surface px-3 text-sm text-neutral-text-primary placeholder:text-neutral-text-secondary focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
        />
      </label>
      {showInvalid && (
        <p id={`${headingId}-err`} role="alert" className="text-xs text-semantic-critical">
          Enter minutes like 45, hours like 1.5, or 1:30 (up to 24 hours).
        </p>
      )}
      {refusal && (
        <p
          role="alert"
          data-testid="cmdk-log-time-error"
          className="text-xs text-semantic-critical"
        >
          {refusal.message}
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onBack}
          className="h-11 md:h-9 rounded-control px-3 text-sm text-neutral-text-secondary hover:text-neutral-text-primary focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
        >
          Back
        </button>
        <button
          type="submit"
          disabled={create.isPending}
          className="h-11 md:h-9 rounded-control bg-brand-primary px-3 text-sm font-medium text-neutral-text-inverse hover:bg-brand-primary/90 focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 disabled:opacity-40 disabled:cursor-default"
        >
          {create.isPending
            ? 'Logging…'
            : minutes !== null
              ? `Log ${formatLoggedMinutes(minutes)}`
              : 'Log time'}
        </button>
      </div>
    </form>
  );
}
