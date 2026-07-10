/**
 * Global "Log time" quick-log popover for the TopBar right cluster (issue 1416,
 * ADR-0185 §C, Pattern C).
 *
 * The app-wide entry point for logging effort from *anywhere* — not only a My
 * Work task row (#1234) or a running timer (#1415). A contributor opens the
 * popover, picks a task (their assigned work, searchable), taps a duration
 * preset (or types one), and logs — the "under 30 seconds" path. Reuses the
 * shared `useCreateTimeEntry` mutation, so the success + Undo toast is identical
 * across every capture surface.
 *
 * The popover is focus-trapped (WCAG 2.4.3 / 2.1.2): Tab cycles within, Escape
 * closes and restores focus to the trigger, and the whole thing is a `dialog`.
 * Enter anywhere in the form logs (the form's submit), matching the design's
 * "↵ to log" affordance.
 *
 * Below `md` the identical form renders inside the shared mobile `BottomSheet`
 * instead of the anchored popover (#1770) — the desktop popover's `w-[360px]`
 * would overflow a phone and its outside-click dismissal fights touch. The sheet
 * owns its own focus trap, so the popover's trap is engaged only on desktop; the
 * roving-focus lookup is scoped to the shared `<form>` element rather than the
 * shell so it works under either surface.
 */
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useMyWork, type MyWorkTask } from '@/hooks/useMyWork';
import { useCreateTimeEntry } from '@/hooks/useCreateTimeEntry';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { formatLoggedMinutes } from '@/lib/formatElapsed';
import { ClockIcon } from '@/components/Icons';
import { parseDurationToMinutes } from './durationInput';

// Always mounted (#1770): icon-only below md, icon + "Log time" label from md up.
// Mobile opens a bottom sheet; desktop opens the anchored popover. `h-11` (44px)
// below md meets the mobile touch-target floor — matching the responsive shrink
// its TopBar siblings use (TimerChip/NotificationBell) — then `md:h-8` on desktop.
const TRIGGER =
  'inline-flex shrink-0 items-center gap-1 h-11 md:h-8 px-2.5 rounded-control border border-chrome-border/15 text-sm font-medium text-chrome-text-primary hover:bg-neutral-text-primary/5 focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 focus:ring-offset-chrome-surface';

const INPUT =
  'h-9 px-3 rounded-control border border-neutral-border bg-neutral-surface text-sm text-neutral-text-primary placeholder:text-neutral-text-disabled focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1';

/** Duration presets — the design's 15m / 30m / 1h / 2h chip row. */
const PRESETS: { label: string; minutes: number }[] = [
  { label: '15m', minutes: 15 },
  { label: '30m', minutes: 30 },
  { label: '1h', minutes: 60 },
  { label: '2h', minutes: 120 },
];

const DEFAULT_MINUTES = 60;

/** Local-timezone today as `YYYY-MM-DD` — the date input's default and max. Uses
 *  local components (not `toISOString`) so logging near midnight doesn't record
 *  a UTC-yesterday entry. */
function localTodayIso(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function taskLabelOf(task: MyWorkTask): string {
  return `${task.short_id} · ${task.name}`;
}

export function QuickLogTime() {
  const [open, setOpen] = useState(false);
  const isMobile = useBreakpoint() === 'sm';
  const headingId = useId();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // The shared form element — the roving-focus lookup scopes to this, not the
  // shell, so it resolves under both the desktop popover and the mobile sheet.
  const formRef = useRef<HTMLFormElement>(null);
  // Desktop popover owns its focus trap; on mobile the BottomSheet owns it, so
  // the popover trap is engaged only when the popover is the surface in play.
  const popoverRef = useFocusTrap<HTMLDivElement>(open && !isMobile, () => setOpen(false));

  const { data } = useMyWork();
  const createEntry = useCreateTimeEntry();

  const [query, setQuery] = useState('');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [minutes, setMinutes] = useState<number>(DEFAULT_MINUTES);
  const [manualText, setManualText] = useState('');
  const [entryDate, setEntryDate] = useState(localTodayIso());
  const [note, setNote] = useState('');

  // Mounted globally in the TopBar, this fires on every route — so it must
  // tolerate an unexpected `/me/work/` payload (API skew, partial outage) and
  // render "no tasks" rather than tear down the whole app via the root error
  // boundary. `p?.results ?? []` guards a page that isn't the paginated shape.
  // Exclude phases (issue #1754, ADR-0293) BEFORE the query filter, so a
  // phase is never selectable, roving-focusable, or the default selection —
  // a phase can't be assigned in the first place (`assignee_on_phase`, #1753),
  // so this is defense-in-depth for the interim / a legacy payload.
  const tasks = useMemo(
    () => (data?.pages ?? []).flatMap((p) => p?.results ?? []).filter((t) => !t.is_phase),
    [data],
  );
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tasks;
    return tasks.filter(
      (t) => t.name.toLowerCase().includes(q) || t.short_id.toLowerCase().includes(q),
    );
  }, [tasks, query]);

  // Re-seat the form to its defaults each time the popover opens so a prior
  // half-filled session never leaks into the next quick-log.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setMinutes(DEFAULT_MINUTES);
    setManualText('');
    setEntryDate(localTodayIso());
    setNote('');
  }, [open]);

  // Default the selection to the first assigned task once the list is available
  // (and keep a valid selection if the current one filters out of view).
  useEffect(() => {
    if (!open) return;
    if (selectedTaskId && tasks.some((t) => t.id === selectedTaskId)) return;
    setSelectedTaskId(tasks[0]?.id ?? null);
  }, [open, tasks, selectedTaskId]);

  // Close on an outside click (the focus trap already handles Escape). Desktop
  // popover only — on mobile the BottomSheet's scrim owns dismissal.
  useEffect(() => {
    if (!open || isMobile) return undefined;
    function onMouseDown(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open, isMobile]);

  // Restore focus to the trigger when the mobile sheet closes (WCAG 2.4.3). The
  // desktop popover gets this from `useFocusTrap`; the shared BottomSheet leaves
  // close-side restoration to the caller, so the mobile path must do it itself to
  // stay symmetric — otherwise focus drops to <body> after submit/cancel/scrim.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open && isMobile) triggerRef.current?.focus();
    wasOpen.current = open;
  }, [open, isMobile]);

  const selectedTask = tasks.find((t) => t.id === selectedTaskId) ?? null;
  // A half-typed manual value keeps `minutes` at its previous (valid) figure, so
  // the enabled state and the submit guard must both consult `manualInvalid` —
  // otherwise the button would log a stale duration the user never typed.
  const manualInvalid = manualText.trim() !== '' && parseDurationToMinutes(manualText) === null;
  const activePreset = manualText.trim() === '' ? minutes : null;
  const canLog = selectedTask !== null && minutes > 0 && !manualInvalid && !createEntry.isPending;
  const selectionInFiltered = filtered.some((t) => t.id === selectedTaskId);

  function selectPreset(m: number) {
    setMinutes(m);
    setManualText('');
  }

  function onManualChange(value: string) {
    setManualText(value);
    const parsed = parseDurationToMinutes(value);
    if (parsed !== null) setMinutes(parsed);
  }

  /** Arrow-key roving selection across the (filtered) task list, so the radio
   *  group honors the ARIA radio keyboard contract, not just its roles. */
  function onTaskKeyDown(e: ReactKeyboardEvent) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    if (filtered.length === 0) return;
    e.preventDefault();
    const idx = filtered.findIndex((t) => t.id === selectedTaskId);
    const delta = e.key === 'ArrowDown' ? 1 : -1;
    const next = filtered[(idx + delta + filtered.length) % filtered.length];
    setSelectedTaskId(next.id);
    // Move focus to the newly-selected radio to match the roving-tabindex model.
    const container = formRef.current;
    container?.querySelector<HTMLElement>(`[data-task-id="${next.id}"]`)?.focus();
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canLog || !selectedTask) return;
    createEntry.mutate({
      taskId: selectedTask.id,
      taskLabel: taskLabelOf(selectedTask),
      minutes,
      entryDate,
      note: note.trim() || undefined,
    });
    setOpen(false);
  }

  const formBody = (
    <form ref={formRef} onSubmit={handleSubmit} className="flex flex-col gap-3">
      <h2 id={headingId} className="text-sm font-semibold text-neutral-text-primary">
        Log time
      </h2>

      {/* Task picker — search over the user's assigned work. */}
      <div className="flex flex-col gap-1.5">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-neutral-text-secondary">Task</span>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your tasks"
            aria-label="Search your tasks"
            className={INPUT}
          />
        </label>
        {tasks.length === 0 ? (
          <p className="px-1 py-2 text-xs text-neutral-text-secondary">
            No assigned tasks to log against yet.
          </p>
        ) : (
          <ul
            role="radiogroup"
            aria-label="Select a task"
            onKeyDown={onTaskKeyDown}
            className="max-h-40 overflow-y-auto rounded-control border border-neutral-border"
          >
            {filtered.length === 0 && (
              <li className="px-2 py-2 text-xs text-neutral-text-secondary">
                No tasks match “{query}”.
              </li>
            )}
            {filtered.map((t) => {
              const selected = t.id === selectedTaskId;
              // Roving tabindex: only the selected radio is tabbable; if the
              // selection has been filtered out of view, the first visible
              // item takes the tab stop so keyboard entry is never stranded.
              const roving = selected || (!selectionInFiltered && t.id === filtered[0]?.id);
              return (
                <li key={t.id}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    tabIndex={roving ? 0 : -1}
                    data-task-id={t.id}
                    onClick={() => setSelectedTaskId(t.id)}
                    className={`flex w-full flex-col gap-0.5 px-2 py-1.5 text-left focus:outline-none focus:ring-2 focus:ring-inset focus:ring-brand-primary ${
                      selected ? 'bg-brand-primary/10' : 'hover:bg-neutral-surface-raised'
                    }`}
                  >
                    <span className="truncate text-sm text-neutral-text-primary">
                      <span className="tppm-mono text-xs text-neutral-text-secondary">
                        {t.short_id}
                      </span>{' '}
                      {t.name}
                    </span>
                    <span className="truncate text-xs text-neutral-text-secondary">
                      {t.project_name}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Duration — preset chips + manual entry. */}
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-neutral-text-secondary" id="quicklog-duration">
          Duration
        </span>
        <div className="flex items-center gap-1.5" role="group" aria-labelledby="quicklog-duration">
          {PRESETS.map((p) => (
            <button
              key={p.minutes}
              type="button"
              aria-pressed={activePreset === p.minutes}
              onClick={() => selectPreset(p.minutes)}
              className={`h-8 flex-1 rounded-control border text-sm font-medium focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 ${
                activePreset === p.minutes
                  ? 'border-brand-primary bg-brand-primary/10 text-brand-primary'
                  : 'border-neutral-border text-neutral-text-primary hover:border-brand-primary/40'
              }`}
            >
              {p.label}
            </button>
          ))}
          <input
            type="text"
            inputMode="numeric"
            value={manualText}
            onChange={(e) => onManualChange(e.target.value)}
            placeholder="1:30"
            aria-label="Custom duration (h:mm or minutes)"
            aria-invalid={manualInvalid}
            className={`tppm-mono h-8 w-16 rounded-control border bg-neutral-surface px-2 text-center text-sm text-neutral-text-primary placeholder:text-neutral-text-disabled focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 ${
              manualInvalid ? 'border-semantic-critical' : 'border-neutral-border'
            }`}
          />
        </div>
        {manualInvalid && (
          <p role="alert" className="text-xs text-semantic-critical">
            Enter a duration like “1:30”, “90”, or “1.5”.
          </p>
        )}
      </div>

      {/* Date — defaults to today; no future entries (server enforces too). */}
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-neutral-text-secondary">Date</span>
        <input
          type="date"
          value={entryDate}
          max={localTodayIso()}
          onChange={(e) => setEntryDate(e.target.value)}
          className={`${INPUT} tppm-mono`}
        />
      </label>

      {/* Note — optional. */}
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-neutral-text-secondary">Note</span>
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={500}
          placeholder="Optional"
          className={INPUT}
        />
      </label>

      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="h-9 rounded-control border border-neutral-border px-4 text-sm font-medium text-neutral-text-secondary hover:text-neutral-text-primary focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!canLog}
          className="h-9 rounded-control bg-brand-primary px-4 text-sm font-medium text-white hover:bg-brand-primary-dark focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Log {formatLoggedMinutes(minutes)}
        </button>
      </div>
    </form>
  );

  return (
    <>
      <div ref={wrapperRef} className="relative shrink-0">
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label="Log time"
          className={TRIGGER}
        >
          <ClockIcon aria-hidden="true" />
          <span className="hidden md:inline">Log time</span>
        </button>

        {/* Desktop: anchored popover with its own focus trap (engaged only here). */}
        {open && !isMobile && (
          <div
            ref={popoverRef}
            role="dialog"
            aria-labelledby={headingId}
            tabIndex={-1}
            className="absolute right-0 top-full mt-1 z-[51] w-[360px] rounded-card border border-neutral-border bg-neutral-surface p-4 shadow-pop"
          >
            {formBody}
          </div>
        )}
      </div>

      {/* Mobile: the identical form inside the shared bottom sheet, which owns its
          scrim dismiss and focus trap. `size="full"` keeps the form usable above
          the software keyboard; the sheet self-gates to below-md via mobileOnly. */}
      {isMobile && (
        <BottomSheet isOpen={open} onClose={() => setOpen(false)} titleId={headingId} size="full">
          <div className="px-4 pb-[env(safe-area-inset-bottom)]">{formBody}</div>
        </BottomSheet>
      )}
    </>
  );
}
