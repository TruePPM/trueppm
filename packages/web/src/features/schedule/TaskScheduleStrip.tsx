import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Task } from '@/types';
import { useUpdateTask } from '@/hooks/useTaskMutations';
import { useEffectiveDurationPolicy } from '@/hooks/useProject';
import { useIsCoarsePointer } from '@/hooks/useIsCoarsePointer';
import { PencilIcon } from '@/components/Icons';
import { parseDurationInput } from './buildMode/EditableCell';
import { RecalcPercentChip } from './RecalcPercentChip';
import { buildRecalcPrompt, type RecalcPromptState } from './recalcPercentPrompt';

/**
 * Format an ISO date (YYYY-MM-DD) as "Mon D", omitting the year when it is the
 * current year. UTC-only arithmetic so the rendered day never drifts by a
 * timezone offset (mirrors MetaRail's formatter, which this component
 * replaces in the tabbed drawer redesign, #962).
 */
function formatDate(iso: string): string {
  const d = new Date(iso + 'T00:00:00Z');
  const currentYear = new Date().getUTCFullYear();
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(d.getUTCFullYear() === currentYear ? {} : { year: 'numeric' }),
    timeZone: 'UTC',
  });
}

interface CellProps {
  label: string;
  children: ReactNode;
  /** Renders the value in the critical-path color (red) when true. */
  critical?: boolean;
  /** Hides the right divider on the last cell. */
  last?: boolean;
}

function Cell({ label, children, critical, last }: CellProps) {
  return (
    <div
      role="group"
      aria-label={label}
      className={['px-3.5 py-2.5', last ? '' : 'border-r border-neutral-border'].join(' ')}
    >
      <div className="text-xs tracking-wider uppercase text-neutral-text-secondary mb-0.5">
        {label}
      </div>
      <div
        className={[
          'tppm-mono text-sm font-semibold',
          critical ? 'text-semantic-critical' : 'text-neutral-text-primary',
        ].join(' ')}
      >
        {children}
      </div>
    </div>
  );
}

/** Pull the server's `{duration: [...]}` validation message off a failed PATCH. */
function extractDurationError(err: unknown): string | null {
  const data = (err as { response?: { data?: { duration?: unknown } } })?.response?.data;
  const d = data?.duration;
  if (Array.isArray(d) && typeof d[0] === 'string') return d[0];
  if (typeof d === 'string') return d;
  return null;
}

interface DurationCellProps {
  /** Current committed duration in working days. */
  days: number;
  /** Always-visible pencil affordance on touch (no hover to reveal it). */
  showPencilAlways: boolean;
  /** Commit a parsed, changed duration. */
  onCommit: (days: number) => void;
  /** A client-side parse failure — the caller surfaces the inline message. */
  onParseError: () => void;
  /** Clear any prior inline error (on edit entry / valid commit). */
  onClearError: () => void;
}

/**
 * The editable Duration cell (#2106, ADR-0515). At rest it is a button that
 * visually matches the read-only vitals cells but carries a dashed underline —
 * the calm, always-present "this one's editable" cue on a strip that is
 * otherwise read-only. Click / Enter / Space / F2 enters an inline numeric
 * input; Enter or blur commits (reusing `parseDurationInput`, so "2w" still
 * works for desktop power users), Esc cancels. The commit is INSTANT (the caller
 * PATCHes immediately) because Start/Finish/Float are server-computed and only
 * meaningful after the CPM recompute — a staged duration would leave them stale.
 */
function DurationCell({
  days,
  showPencilAlways,
  onCommit,
  onParseError,
  onClearError,
}: DurationCellProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(days));
  const [flash, setFlash] = useState<'commit' | 'error' | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const prevEditingRef = useRef(false);
  // Set when Enter/Esc exit — focus returns to the at-rest button. A blur/Tab
  // exit leaves it unset so focus follows the natural tab order.
  const focusButtonRef = useRef(false);
  // Set on Enter/Esc so the unmount-triggered blur doesn't re-run the commit.
  const skipNextBlurRef = useRef(false);

  // Reseed the draft when the committed value changes from outside (WS/CPM).
  useEffect(() => {
    if (!editing) setDraft(String(days));
  }, [days, editing]);

  // Focus + select on entering edit mode; return focus to the button on an
  // Enter/Esc exit (never drop focus to <body>, WCAG 2.4.3).
  useEffect(() => {
    if (editing && !prevEditingRef.current) {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else if (!editing && prevEditingRef.current && focusButtonRef.current) {
      focusButtonRef.current = false;
      buttonRef.current?.focus();
    }
    prevEditingRef.current = editing;
  }, [editing]);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), flash === 'commit' ? 400 : 600);
    return () => clearTimeout(t);
  }, [flash]);

  const startEdit = () => {
    onClearError();
    setDraft(String(days));
    setEditing(true);
  };

  const commit = (raw: string, viaBlur: boolean) => {
    const parsed = parseDurationInput(raw);
    if (parsed === null) {
      onParseError();
      setFlash('error');
      // On blur we cannot hold an open input — revert to the committed value.
      // On Enter we stay in edit mode so the user can fix the input (rule 225).
      if (viaBlur) {
        setDraft(String(days));
        setEditing(false);
      }
      return;
    }
    onClearError();
    if (parsed !== days) {
      onCommit(parsed);
      setFlash('commit');
    }
    setEditing(false);
  };

  const cellBase = 'px-3.5 py-2.5 border-r border-neutral-border min-h-11';
  const flashClass =
    flash === 'commit'
      ? 'bg-semantic-on-track-bg'
      : flash === 'error'
        ? 'bg-semantic-critical-bg'
        : '';

  if (editing) {
    return (
      <div role="group" aria-label="Duration" className={[cellBase, flashClass].join(' ')}>
        <div className="text-xs tracking-wider uppercase text-neutral-text-secondary mb-0.5">
          Duration
        </div>
        <div className="flex items-baseline gap-0.5">
          <input
            ref={inputRef}
            value={draft}
            inputMode="numeric"
            aria-label="Duration in days"
            className="tppm-mono text-sm font-semibold w-12 bg-neutral-surface text-neutral-text-primary
              px-1 rounded-sm outline-none border border-brand-primary
              focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
              focus-visible:ring-offset-neutral-surface"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              if (skipNextBlurRef.current) {
                skipNextBlurRef.current = false;
                return;
              }
              commit(draft, true);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                skipNextBlurRef.current = true;
                focusButtonRef.current = true;
                commit(draft, false);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                skipNextBlurRef.current = true;
                focusButtonRef.current = true;
                onClearError();
                setDraft(String(days));
                setEditing(false);
              }
            }}
          />
          <span
            className="tppm-mono text-sm font-semibold text-neutral-text-secondary"
            aria-hidden="true"
          >
            d
          </span>
        </div>
      </div>
    );
  }

  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label={`Duration, ${days} ${days === 1 ? 'day' : 'days'}. Edit.`}
      className={[
        'group relative flex flex-col items-start text-left w-full cursor-text',
        'transition-colors hover:bg-neutral-surface-sunken',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary',
        'focus-visible:ring-offset-1 focus-visible:ring-offset-neutral-surface',
        cellBase,
        flashClass,
      ].join(' ')}
      onClick={startEdit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'F2') {
          e.preventDefault();
          startEdit();
        }
      }}
    >
      <span className="text-xs tracking-wider uppercase text-neutral-text-secondary mb-0.5">
        Duration
      </span>
      <span
        className="tppm-mono text-sm font-semibold text-neutral-text-primary
          border-b border-dashed border-neutral-border group-hover:border-brand-primary"
      >
        {days}d
      </span>
      <PencilIcon
        aria-hidden="true"
        className={[
          'absolute top-2 right-2 h-3 w-3 text-neutral-text-secondary transition-opacity',
          // Faintly persistent at rest so a mouse user sees the cell is editable
          // without hovering (the whole point of #2106); full-strength on
          // hover/focus, and always-on for touch (no hover to reveal it).
          showPencilAlways
            ? 'opacity-100'
            : 'opacity-40 group-hover:opacity-100 group-focus-visible:opacity-100',
        ].join(' ')}
      />
    </button>
  );
}

/**
 * Pure render of the bordered vitals frame — Start · Finish · {duration slot} ·
 * Float, plus an optional below-grid slot (inline error / recalc prompt) and the
 * critical-path banner. Calls no data hooks, so the read-only strip stays
 * provider-free; the editable variant supplies its own `durationCell`/`belowGrid`.
 */
function StripFrame({
  task,
  durationCell,
  belowGrid,
}: {
  task: Task;
  durationCell: ReactNode | null;
  belowGrid?: ReactNode;
}) {
  const hasSchedule = Boolean(task.start);
  const float = task.totalFloat;
  const dash = <span className="text-neutral-text-disabled font-normal">—</span>;

  return (
    <div className="rounded-card border border-neutral-border overflow-hidden">
      <div className={['grid', task.isMilestone ? 'grid-cols-2' : 'grid-cols-4'].join(' ')}>
        <Cell label={task.isMilestone ? 'Date' : 'Start'}>
          {hasSchedule ? formatDate(task.start) : dash}
        </Cell>

        {!task.isMilestone && (
          <Cell label="Finish">{hasSchedule ? formatDate(task.finish) : dash}</Cell>
        )}

        {durationCell}

        <Cell label="Float" critical={task.isCritical} last>
          {float === null || float === undefined ? (
            dash
          ) : task.isCritical ? (
            <span title="This task is on the critical path — a delay here delays the project end date">
              {float}d · CP
            </span>
          ) : (
            `${float}d`
          )}
        </Cell>
      </div>

      {belowGrid}

      {task.isCritical && (
        <div className="flex items-center gap-2 px-3.5 py-2 border-t border-neutral-border bg-semantic-critical-bg text-xs text-semantic-critical">
          <span
            aria-hidden="true"
            className="w-1.5 h-1.5 rounded-full bg-semantic-critical shrink-0"
          />
          <span>On the critical path — zero float. Slipping this moves the project finish.</span>
        </div>
      )}
    </div>
  );
}

/**
 * Editable variant of the strip (#2106, ADR-0515). Owns the mutation, the
 * ADR-0151 recalc-% prompt, and the inline error/announce state; only mounted
 * for a non-milestone task the user can edit, so all data hooks live here and
 * the read-only path never needs a QueryClient.
 */
function EditableStrip({ task, projectId }: { task: Task; projectId: string }) {
  const updateTask = useUpdateTask();
  const policy = useEffectiveDurationPolicy(projectId);
  const isCoarse = useIsCoarsePointer();

  const [recalcPrompt, setRecalcPrompt] = useState<RecalcPromptState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState('');

  const commitDuration = (newDays: number) => {
    // Scheduling changes need the server (CPM recompute), so guard offline
    // rather than optimistically queue a change we cannot recompute (rule 29).
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setError("You're offline — reconnect to change duration.");
      return;
    }
    const oldDuration = task.duration;
    const oldPercent = task.progress;
    setError(null);
    updateTask.mutate(
      { id: task.id, projectId, duration: newDays },
      {
        onSuccess: () => {
          setLive(
            `Duration set to ${newDays} ${newDays === 1 ? 'day' : 'days'}. Schedule updated.`,
          );
          // The recalc-% prompt is a post-commit follow-up (ADR-0151): only build
          // it once the edit actually landed, so a rejected edit never prompts.
          setRecalcPrompt(
            buildRecalcPrompt({
              taskId: task.id,
              policy,
              oldPercent,
              oldDuration,
              newDuration: newDays,
              suppressed: isCoarse,
            }),
          );
        },
        onError: (err) => {
          // The optimistic patch is already rolled back by the hook; surface the
          // server span-cap message (#1862) inline rather than a silent failure.
          setError(extractDurationError(err) ?? 'Could not update the duration.');
        },
      },
    );
  };

  const belowGrid = (
    <>
      {error && (
        <div
          role="alert"
          className="flex items-center px-3.5 py-2 border-t border-neutral-border
            bg-semantic-critical-bg text-xs text-semantic-critical"
        >
          {error}
        </div>
      )}

      {recalcPrompt && recalcPrompt.taskId === task.id && (
        <div className="px-3.5 py-2 border-t border-neutral-border">
          <RecalcPercentChip
            prompt={recalcPrompt}
            onAccept={async (percent) => {
              await updateTask.mutateAsync({ id: task.id, projectId, percent_complete: percent });
            }}
            onDismiss={() => setRecalcPrompt(null)}
          />
        </div>
      )}
    </>
  );

  return (
    <div aria-label="Schedule" role="group">
      <StripFrame
        task={task}
        durationCell={
          <DurationCell
            days={task.duration}
            showPencilAlways={isCoarse}
            onCommit={commitDuration}
            onParseError={() => setError('Enter a whole number of days (e.g. 10).')}
            onClearError={() => setError(null)}
          />
        }
        belowGrid={belowGrid}
      />
      <div role="status" aria-live="polite" className="sr-only">
        {live}
      </div>
    </div>
  );
}

/**
 * The schedule "vitals" strip at the top of the Details tab — Start, Finish,
 * Duration, Float in a bordered 4-up grid, with a plain-English critical-path
 * banner when the task is on the critical path (web-rule 49). Replaces the
 * sticky left meta rail from the pre-#962 drawer.
 *
 * Milestones (ADR-0058) relabel Start → "Date" and suppress Finish/Duration —
 * a milestone is a single point in time with no span.
 *
 * When `projectId` + `canEdit` are supplied for a non-milestone task, the
 * Duration cell becomes inline-editable (#2106, ADR-0515): an instant PATCH that
 * lets the strip refresh to the recomputed Start/Finish/Float, honoring the
 * ADR-0151 duration-change percent policy. Absent either prop the strip is the
 * original read-only grid.
 */
export function TaskScheduleStrip({
  task,
  projectId,
  canEdit,
}: {
  task: Task;
  projectId?: string;
  canEdit?: boolean;
}) {
  if (canEdit && projectId && !task.isMilestone) {
    return <EditableStrip task={task} projectId={projectId} />;
  }

  return (
    <div aria-label="Schedule" role="group">
      <StripFrame
        task={task}
        durationCell={task.isMilestone ? null : <Cell label="Duration">{task.duration}d</Cell>}
      />
    </div>
  );
}
