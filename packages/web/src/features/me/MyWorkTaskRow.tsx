/**
 * Single task row on /me/work (issue #499, ADR-0065 Gap 2).
 *
 * Card layout at < md, condensed list row at md+. Contains:
 *   - critical-path indicator (icon + tooltip, never the words "critical path")
 *   - short_id badge
 *   - task name (deep link to /projects/{id}/schedule?task={id})
 *   - project · sprint line
 *   - status chip (tap → opens StatusPicker)
 *   - story-point / remaining-point display
 *   - due date with `due_source` suffix (e.g. "Due May 30 (planned)")
 */
import { WarningIcon } from '@/components/Icons';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { TaskStatus } from '@/types';
import { useMyWorkStatusUpdate, type MyWorkTask } from '@/hooks/useMyWork';
import { useActiveTimer, useElapsedSeconds } from '@/hooks/useActiveTimer';
import { useTimeRollup } from '@/hooks/useTimeEntry';
import { blockerTypeLabel, formatBlockedAge } from '@/lib/blocker';
import { formatElapsed } from '@/lib/formatElapsed';
import { formatMinutesAsHm } from '@/lib/parseHours';
import { formatDueLabel } from './dueLabel';
import { LogTimePopover } from './LogTimePopover';
import { StatusPicker } from './StatusPicker';
import {
  PendingAcceptanceChip,
  pendingAcceptanceExplainer,
} from '@/features/board/PendingAcceptanceChip';
import { ProgramIdentitySquare } from '@/features/programs/ProgramIdentitySquare';
import { toast } from '@/components/Toast';

const STATUS_LABEL: Record<TaskStatus, string> = {
  BACKLOG: 'Backlog',
  NOT_STARTED: 'Not started',
  IN_PROGRESS: 'In progress',
  REVIEW: 'In review',
  ON_HOLD: 'On hold',
  COMPLETE: 'Complete',
};

// Status chip token classes — pair the pre-computed -bg fill with the matching
// full token for text and a 40% border (frontend/CLAUDE.md rule 8b, rule 39).
const STATUS_CHIP_CLASSES: Record<TaskStatus, string> = {
  BACKLOG: 'bg-neutral-surface-sunken text-neutral-text-secondary border-neutral-border',
  NOT_STARTED: 'bg-neutral-surface-sunken text-neutral-text-secondary border-neutral-border',
  IN_PROGRESS: 'bg-brand-primary/10 text-brand-primary border-brand-primary/40',
  REVIEW: 'bg-brand-accent-light text-brand-accent-dark border-brand-accent/40',
  ON_HOLD: 'bg-neutral-surface-sunken text-neutral-text-secondary border-neutral-border',
  COMPLETE: 'bg-semantic-on-track-bg text-semantic-on-track border-semantic-on-track/40',
};

interface Props {
  task: MyWorkTask;
}

/**
 * Start/stop time-entry control for a single My Work row (issue 1415, ADR-0185 §C).
 *
 * When this task's timer is running the button becomes a stop control with the
 * live inline elapsed (the "active row mirrors the running state" treatment);
 * otherwise it is a play control that starts a timer here. Starting while
 * another task's timer runs is handled server-side (that timer is auto-stopped
 * and logged), so the button is always a plain play when this task is idle.
 *
 * Extracted so the per-second elapsed tick re-renders only the one running row —
 * `useElapsedSeconds` is inert (no interval) when this task is not running.
 */
function TaskTimerControl({ task }: Props) {
  const { timer, startTimer, stopTimer, isTaskRunning, isStarting, isStopping } = useActiveTimer();
  const running = isTaskRunning(task.id);
  const elapsed = useElapsedSeconds(running ? timer?.started_at : null);
  const isComplete = task.status === 'COMPLETE';

  if (running) {
    // Standalone timer button uses focus: not focus-visible: — Firefox/Safari skip
    // :focus-visible on pointer focus, leaving no ring after a click (rule 214). The
    // navigating <Link>s in this row keep focus-visible:.
    return (
      <button
        type="button"
        onClick={() => stopTimer()}
        disabled={isStopping}
        aria-label={`Stop timer on ${task.name} and log time`}
        className="inline-flex h-11 items-center gap-1.5 rounded-control px-2 md:h-7
          border border-semantic-on-track/40 bg-semantic-on-track-bg text-semantic-on-track
          focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1
          disabled:cursor-progress disabled:opacity-60"
      >
        <span className="grid h-3.5 w-3.5 place-items-center rounded-[3px] bg-current" aria-hidden="true">
          <span className="h-1.5 w-1.5 rounded-[1px] bg-semantic-on-track-bg" />
        </span>
        <span className="tppm-mono text-xs" aria-hidden="true">
          {formatElapsed(elapsed)}
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => startTimer(task.id)}
      disabled={isStarting || isComplete}
      aria-label={`Start timer on ${task.name}`}
      title="Start timer"
      className="grid h-11 w-11 shrink-0 place-items-center rounded-control text-neutral-text-secondary md:h-7 md:w-7
        hover:text-brand-primary hover:bg-brand-primary/5
        focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1
        disabled:opacity-40 disabled:cursor-default disabled:hover:bg-transparent"
    >
      {/* Play triangle. */}
      <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
        <path d="M2.5 1.5v9l7-4.5-7-4.5z" />
      </svg>
    </button>
  );
}

export function MyWorkTaskRow({ task }: Props) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  // One-shot flag that plays the checkpop spring on the checkbox when this task
  // is marked complete (cleared on animationend). v2 fluidity, rule 181/184.
  const [justCompleted, setJustCompleted] = useState(false);
  const updateStatus = useMyWorkStatusUpdate();
  const rollup = useTimeRollup();
  const loggedToday = rollup.loggedTodayForTask(task.id);
  const rowRef = useRef<HTMLLIElement | null>(null);
  const due = formatDueLabel(task.due, task.due_source);
  const isComplete = task.status === 'COMPLETE';

  // `L` opens the quick-log popover when focus is within the row (but not in a text
  // field) — the keyboard peer of the row's "Log time" action (design "Web Time Entry").
  // Attached natively (not a JSX handler on the non-interactive <li>) so the shortcut
  // fires from any focused control in the row without an a11y-role hack.
  useEffect(() => {
    const row = rowRef.current;
    if (!row) return undefined;
    function onKeyDown(e: KeyboardEvent) {
      if ((e.key !== 'l' && e.key !== 'L') || e.metaKey || e.ctrlKey || e.altKey || logOpen) return;
      const target = e.target as HTMLElement;
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable
      ) {
        return;
      }
      e.preventDefault();
      setLogOpen(true);
    }
    row.addEventListener('keydown', onKeyDown);
    return () => row.removeEventListener('keydown', onKeyDown);
  }, [logOpen]);

  // Complete via the checkbox (or the picker's Complete entry). The spring fires
  // immediately for snappy local feedback; the warm toast fires on the actual
  // success — the mutation is optimistic with rollback, so we only celebrate a
  // confirmed completion (the signature v2 "moment of delight").
  function completeTask() {
    if (isComplete || updateStatus.isPending) return;
    setJustCompleted(true);
    updateStatus.mutate(
      { taskId: task.id, next: 'COMPLETE', previous: task.status },
      { onSuccess: () => toast.warm(`Nice — ${task.name} done.`) },
    );
  }

  function handleSelect(next: TaskStatus) {
    setPickerOpen(false);
    if (next === task.status) return;
    if (next === 'COMPLETE') {
      completeTask();
      return;
    }
    updateStatus.mutate({ taskId: task.id, next, previous: task.status });
  }

  const pointsText =
    task.story_points == null
      ? null
      : task.remaining_points != null && task.remaining_points !== task.story_points
        ? `${task.story_points}pts · ${task.remaining_points} left`
        : `${task.story_points}pts`;

  // Defense-in-depth (issue #1754, ADR-0293): a phase never becomes an
  // actionable My Work row. MyWorkPage already filters `allTasks` before this
  // renders, and a phase can't be assigned in the first place
  // (`assignee_on_phase`, #1753), so this never legitimately fires — kept for
  // a stray caller. Placed after every hook call above (rules-of-hooks).
  if (task.is_phase) return null;

  return (
    <li
      ref={rowRef}
      className={[
        'relative flex flex-col gap-1 px-3 py-3 border-b border-neutral-border/40',
        'md:flex-row md:items-center md:gap-3 md:py-2 md:min-h-11',
        // Blocked tasks (#476/#855) carry a left accent so they read as
        // "needs attention" at a glance — they also sort first within a group.
        task.is_blocked ? 'border-l-2 border-l-semantic-critical' : '',
      ].join(' ')}
    >
      {/* Top line on mobile / leading slot on md+: complete checkbox + critical
          indicator + short_id. The checkbox is the contributor's one-tap complete
          (proto's signature) — 44px touch target on mobile, compact on md+. */}
      <div className="flex items-center gap-2 md:w-32 md:shrink-0">
        <button
          type="button"
          onClick={completeTask}
          disabled={isComplete || updateStatus.isPending}
          aria-pressed={isComplete}
          aria-label={isComplete ? `${task.name} is complete` : `Mark ${task.name} complete`}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-control md:h-7 md:w-7
            focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1
            disabled:cursor-default"
        >
          <span
            onAnimationEnd={() => setJustCompleted(false)}
            className={[
              'grid h-[18px] w-[18px] place-items-center rounded-[5px] border-[1.5px] text-xs leading-none',
              isComplete
                ? 'border-brand-primary bg-brand-primary text-neutral-text-inverse'
                : 'border-neutral-border text-transparent',
              justCompleted ? 'motion-safe:animate-checkpop' : '',
            ].join(' ')}
          >
            <span aria-hidden="true">✓</span>
          </span>
        </button>
        {task.is_critical && (
          <span
            className="text-semantic-critical text-sm leading-none"
            title="On the critical path — a delay here delays the project end date"
            aria-label="On the critical path"
          >
            <WarningIcon className="inline-block h-3 w-3 align-[-0.125em]" aria-hidden="true" />
          </span>
        )}
        <span className="tppm-mono text-xs text-neutral-text-secondary">{task.short_id}</span>
      </div>

      {/* Name + project · sprint context. On md+ this is the flex-grow column. */}
      <div className="flex-1 min-w-0">
        <Link
          to={task.url}
          className="block text-sm font-medium text-neutral-text-primary leading-tight
            hover:underline focus-visible:outline-none focus-visible:ring-2
            focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded-control"
        >
          {task.name}
        </Link>
        <p className="mt-0.5 text-xs text-neutral-text-secondary truncate">
          <Link
            to={`/projects/${task.project_id}/overview`}
            className="hover:underline focus-visible:outline-none focus-visible:ring-2
              focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded-control"
          >
            {task.project_name}
          </Link>
          {task.sprint_name && (
            <>
              <span aria-hidden="true"> · </span>
              {task.sprint_name}
            </>
          )}
          {/* ADR-0102 §6: a task injected into its active sprint shows the
              passive pending chip here so the assignee sees what's heading their
              way — but NO accept/reject controls ever render in the me tree
              (the decision is team-owned, frontend rule 144). */}
          {task.sprint_pending && (
            <>
              <span aria-hidden="true"> · </span>
              {/* #1472: tap-to-explain here too — My Work is the assignee's home
                  surface, where the "signal I can't act on" is felt most. Generic
                  copy (default iteration noun): My Work is cross-project, so no
                  single project's iteration label applies. Still NO accept/reject
                  in the me tree (rule 144) — the explainer is close-only. */}
              <PendingAcceptanceChip explainer={pendingAcceptanceExplainer()} />
            </>
          )}
        </p>
        {/* Program identity line (#964, follow-up to #963). My Work is the
            genuinely cross-program list, so each row earns a per-row program
            marker for wayfinding. The square is decorative (aria-hidden); the
            program NAME is the accessible signal. An orphan project (no program)
            still renders the neutral unset square, with no name — consistent
            with the rest of the #963 identity system (shape = program, color =
            which program). */}
        <p className="mt-0.5 flex items-center gap-1.5 text-xs text-neutral-text-secondary">
          <ProgramIdentitySquare
            program={{ color: task.program_color, name: task.program_name ?? '', code: '' }}
            size="sm"
          />
          {task.program_name && <span className="truncate">{task.program_name}</span>}
        </p>
        {/* Blocked badge (#476/#855, ADR-0124 #1135) — the human flag, not the
            board's dependency-readiness signal. Shows the structured type chip +
            an age ("Xd Yh blocked") alongside the private reason (My Work is the
            assignee's own surface, so the reason is always theirs to read). */}
        {task.is_blocked && (
          <p className="mt-1 flex flex-wrap items-start gap-1.5 text-xs text-semantic-critical">
            <span
              className="inline-flex shrink-0 items-center gap-1 rounded-chip px-1.5 py-0.5 font-semibold
                bg-semantic-critical-bg border border-semantic-critical/40"
            >
              <span aria-hidden="true">●</span> <span>Blocked</span>
            </span>
            {task.blocker_type && (
              <span className="inline-flex shrink-0 items-center rounded-chip px-1.5 py-0.5 font-medium
                bg-neutral-surface-sunken text-neutral-text-secondary border border-neutral-border">
                {blockerTypeLabel(task.blocker_type)}
              </span>
            )}
            {formatBlockedAge(task.blocked_age_seconds) && (
              <span className="shrink-0 text-neutral-text-secondary tppm-mono">
                {formatBlockedAge(task.blocked_age_seconds)}
              </span>
            )}
            {task.blocked_reason && (
              <span className="min-w-0 text-neutral-text-secondary">{task.blocked_reason}</span>
            )}
          </p>
        )}
      </div>

      {/* Time cluster — logged-today chip (#1234), manual quick-log popover (#1234),
          and the running-timer control (#1415). The wrapper is the popover's
          positioning context (anchored right). */}
      <div className="relative flex shrink-0 items-center gap-1">
        {loggedToday > 0 && (
          <span
            className="tppm-mono text-xs text-neutral-text-secondary"
            title="Logged today"
            aria-label={`${formatMinutesAsHm(loggedToday)} logged today`}
          >
            {formatMinutesAsHm(loggedToday)}
          </span>
        )}
        <button
          type="button"
          onClick={() => setLogOpen((v) => !v)}
          aria-haspopup="dialog"
          aria-expanded={logOpen}
          aria-label={`Log time on ${task.name}`}
          title="Log time (L)"
          className="grid h-11 w-11 shrink-0 place-items-center rounded-control text-neutral-text-secondary md:h-7 md:w-7
            hover:text-brand-primary hover:bg-brand-primary/5
            focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
        >
          {/* Clock face with a small plus. */}
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
            <circle cx="6.5" cy="7.5" r="5" stroke="currentColor" strokeWidth="1.3" />
            <path d="M6.5 4.8V7.5l1.8 1.1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M12 2.2v3M13.5 3.7h-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
        </button>
        <TaskTimerControl task={task} />
        {logOpen && <LogTimePopover task={task} onClose={() => setLogOpen(false)} />}
      </div>

      {/* Status chip — opens StatusPicker popover on tap. */}
      <div className="relative md:w-32 md:shrink-0">
        <button
          type="button"
          onClick={() => setPickerOpen((v) => !v)}
          aria-haspopup="dialog"
          aria-expanded={pickerOpen}
          aria-label={`Status: ${STATUS_LABEL[task.status]}, change`}
          disabled={updateStatus.isPending}
          className={[
            'inline-flex h-7 min-w-[7rem] items-center justify-center gap-1 rounded-control',
            'border px-2 py-0.5 text-xs font-medium',
            'focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1',
            'disabled:opacity-60 disabled:cursor-progress',
            STATUS_CHIP_CLASSES[task.status],
          ].join(' ')}
        >
          {updateStatus.isPending ? 'Updating…' : STATUS_LABEL[task.status]}
        </button>
        {pickerOpen && (
          <StatusPicker
            taskName={task.name}
            current={task.status}
            onSelect={handleSelect}
            onClose={() => setPickerOpen(false)}
          />
        )}
      </div>

      {/* Points + due — right-aligned numerical info on md+. */}
      <div className="flex items-center justify-between gap-3 md:gap-4 md:w-56 md:shrink-0 md:justify-end">
        <span
          className="tppm-mono text-xs text-neutral-text-secondary"
          aria-label={
            task.story_points == null
              ? undefined
              : task.remaining_points != null && task.remaining_points !== task.story_points
                ? `${task.story_points} story points, ${task.remaining_points} remaining`
                : `${task.story_points} story points`
          }
        >
          {pointsText}
        </span>
        <span className="tppm-mono text-xs text-neutral-text-secondary" aria-label={due.sr}>
          {due.text}
        </span>
      </div>
    </li>
  );
}
