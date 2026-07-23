/**
 * Row-anchored quick-log time popover for My Work (#1234, design "Web Time Entry" §A).
 *
 * Springs open from a task row's "Log time" action (or the `L` key on the row) — the task
 * is already known, so unlike the global popover (#1416) there is no task picker. Offers a
 * big mono duration read-out, preset chips (15m/30m/1h/2h/4h), a custom `h`/`h:mm` field, a
 * Date control (default today, backdate-window bounded), and an optional note. `↵` logs,
 * `esc` cancels. On success it fires the shared success + Undo toast (pattern D), whose
 * Undo deletes the just-created entry.
 *
 * Presentational + local input state only; the create/delete lifecycle and optimistic
 * cache writes live in `useCreateTimeEntry` / `useDeleteTimeEntry`.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { toast } from '@/components/Toast';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { formatMinutesAsHm, parseHoursToMinutes } from '@/lib/parseHours';
import { addDaysIso } from '@/features/timesheet/weekModel';
import {
  TIME_PRESETS,
  todayIso,
  useCreateTimeEntry,
  useDeleteTimeEntry,
} from '@/hooks/useTimeEntry';

/** The minimal task shape the popover needs — `MyWorkTask` satisfies it structurally. */
export interface LogTimePopoverTask {
  id: string;
  short_id: string;
  name: string;
  project_id: string;
  project_name: string;
}

interface Props {
  task: LogTimePopoverTask;
  onClose: () => void;
}

/** Backdate window mirrors the server default (`TIMETRACKING_BACKDATE_DAYS`, 60). */
const BACKDATE_DAYS = 60;

export function LogTimePopover({ task, onClose }: Props) {
  const containerRef = useFocusTrap<HTMLDivElement>(true, onClose);
  const create = useCreateTimeEntry();
  const del = useDeleteTimeEntry();

  const customRef = useRef<HTMLInputElement | null>(null);
  const [minutes, setMinutes] = useState(0);
  const [custom, setCustom] = useState('');
  const [entryDate, setEntryDate] = useState(() => todayIso());
  const [note, setNote] = useState('');

  // Focus the custom-duration field on open so a keyboard user can type + ↵ immediately.
  // Runs after the focus trap's initial focus (declared first), which lands on a preset.
  useEffect(() => {
    customRef.current?.focus();
  }, []);

  const today = todayIso();
  const minDate = addDaysIso(today, -BACKDATE_DAYS);

  // Custom overrides a preset. Blank parses to 0 (log disabled); unparseable → null (a
  // hint shows and log is blocked) while the last valid `minutes` is preserved visually.
  const customInvalid = custom.trim() !== '' && parseHoursToMinutes(custom) === null;
  const canLog = minutes > 0 && !customInvalid && !create.isPending;
  const hm = formatMinutesAsHm(minutes);

  // Dismiss on pointer-down outside (Escape is handled by the focus trap).
  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node | null;
      if (containerRef.current && target && !containerRef.current.contains(target)) {
        onClose();
      }
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [onClose, containerRef]);

  function selectPreset(m: number) {
    setMinutes(m);
    setCustom('');
  }

  function onCustomChange(value: string) {
    setCustom(value);
    const parsed = parseHoursToMinutes(value);
    if (parsed !== null) setMinutes(parsed);
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canLog) return;
    const label = hm;
    create.mutate(
      {
        taskId: task.id,
        taskShortId: task.short_id,
        taskName: task.name,
        projectId: task.project_id,
        projectName: task.project_name,
        minutes,
        entryDate,
        note: note.trim(),
      },
      {
        onSuccess: (created) => {
          toast.action(
            `Logged ${label} to ${task.short_id}`,
            {
              label: 'Undo',
              ariaLabel: `Undo logging ${label} to ${task.name}`,
              onClick: () => del.mutate({ entryId: created.id, entryDate }),
            },
            { variant: 'success' },
          );
          onClose();
        },
        onError: () => toast.error("Couldn't log time — try again."),
      },
    );
  }

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="log-time-title"
      className="absolute right-0 z-30 mt-1 w-72 rounded-card border border-neutral-border
        bg-neutral-surface shadow-pop focus-within:ring-2 focus-within:ring-brand-primary"
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-3 p-3">
        <div
          id="log-time-title"
          className="flex items-baseline justify-between gap-2 text-xs font-semibold
            tracking-widest uppercase text-neutral-text-secondary"
        >
          <span className="truncate">Log time · {task.short_id}</span>
          <span aria-live="polite" className="tppm-mono text-base font-bold normal-case tracking-normal
            text-neutral-text-primary" aria-label={`${hm} selected`}>
            {hm}
          </span>
        </div>

        {/* Preset chips — one tap sets a common duration. */}
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Duration presets">
          {TIME_PRESETS.map((preset) => {
            const active = custom.trim() === '' && minutes === preset.minutes;
            return (
              <button
                key={preset.minutes}
                type="button"
                onClick={() => selectPreset(preset.minutes)}
                aria-pressed={active}
                className={[
                  'h-11 min-w-[3rem] rounded-control border px-2 text-sm font-medium md:h-8',
                  // Preset chip-as-button: focus: not focus-visible: — Firefox/Safari skip
                  // :focus-visible on pointer focus (rule 214). The inputs below keep focus-visible:.
                  'focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1',
                  active
                    ? 'border-brand-primary bg-brand-primary/10 text-brand-primary'
                    : 'border-neutral-border text-neutral-text-secondary hover:bg-neutral-surface-raised',
                ].join(' ')}
              >
                {preset.label}
              </button>
            );
          })}
        </div>

        {/* Custom entry — `h` or `h:mm`. Autofocused so a keyboard user can type + ↵. */}
        <label className="flex flex-col gap-1 text-xs text-neutral-text-secondary">
          Custom (h or h:mm)
          <input
            ref={customRef}
            type="text"
            inputMode="decimal"
            value={custom}
            onChange={(e) => onCustomChange(e.target.value)}
            placeholder="e.g. 1:30 or 1.5"
            aria-invalid={customInvalid}
            aria-describedby={customInvalid ? 'log-time-custom-error' : undefined}
            className={[
              'h-11 md:h-9 rounded-control border bg-neutral-surface px-2 text-sm text-neutral-text-primary',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
              customInvalid ? 'border-semantic-critical' : 'border-neutral-border',
            ].join(' ')}
          />
          {customInvalid && (
            <span id="log-time-custom-error" className="text-semantic-critical">
              Enter hours like 1.5 or 1:30.
            </span>
          )}
        </label>

        {/* Date — defaults to today; bounded by the backdate window and no future. */}
        <label className="flex flex-col gap-1 text-xs text-neutral-text-secondary">
          Date
          <input
            type="date"
            value={entryDate}
            min={minDate}
            max={today}
            onChange={(e) => setEntryDate(e.target.value)}
            className="h-11 md:h-9 rounded-control border border-neutral-border bg-neutral-surface px-2 text-sm
              text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2
              focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          />
        </label>

        {/* Optional note. */}
        <label className="flex flex-col gap-1 text-xs text-neutral-text-secondary">
          Note (optional)
          <input
            type="text"
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What did you work on?"
            className="h-11 md:h-9 rounded-control border border-neutral-border bg-neutral-surface px-2 text-sm
              text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2
              focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          />
        </label>

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="h-11 md:h-9 rounded-control px-3 text-sm text-neutral-text-secondary
              hover:text-neutral-text-primary focus:outline-none focus:ring-2
              focus:ring-brand-primary focus:ring-offset-1"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canLog}
            className="h-11 md:h-9 rounded-control bg-brand-primary px-3 text-sm font-medium text-neutral-text-inverse
              hover:bg-brand-primary/90 focus:outline-none focus:ring-2
              focus:ring-brand-primary focus:ring-offset-1
              disabled:opacity-40 disabled:cursor-default"
          >
            {create.isPending ? 'Logging…' : `Log ${hm}`}
          </button>
        </div>
      </form>
    </div>
  );
}
