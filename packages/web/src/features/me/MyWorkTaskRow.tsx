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
import { useState } from 'react';
import { Link } from 'react-router';
import type { TaskStatus } from '@/types';
import { useMyWorkStatusUpdate, type MyWorkTask } from '@/hooks/useMyWork';
import { blockerTypeLabel, formatBlockedAge } from '@/lib/blocker';
import { formatDueLabel } from './dueLabel';
import { StatusPicker } from './StatusPicker';
import { PendingAcceptanceChip } from '@/features/board/PendingAcceptanceChip';
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

export function MyWorkTaskRow({ task }: Props) {
  const [pickerOpen, setPickerOpen] = useState(false);
  // One-shot flag that plays the checkpop spring on the checkbox when this task
  // is marked complete (cleared on animationend). v2 fluidity, rule 181/184.
  const [justCompleted, setJustCompleted] = useState(false);
  const updateStatus = useMyWorkStatusUpdate();
  const due = formatDueLabel(task.due, task.due_source);
  const isComplete = task.status === 'COMPLETE';

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

  return (
    <li
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
          className="grid h-11 w-11 shrink-0 place-items-center rounded md:h-7 md:w-7
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
            disabled:cursor-default"
        >
          <span
            onAnimationEnd={() => setJustCompleted(false)}
            className={[
              'grid h-[18px] w-[18px] place-items-center rounded-[5px] border-[1.5px] text-[11px] leading-none',
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
            <span aria-hidden="true">⚠</span>
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
            focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded-sm"
        >
          {task.name}
        </Link>
        <p className="mt-0.5 text-xs text-neutral-text-secondary truncate">
          <Link
            to={`/projects/${task.project_id}/overview`}
            className="hover:underline focus-visible:outline-none focus-visible:ring-2
              focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded-sm"
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
              <PendingAcceptanceChip />
            </>
          )}
        </p>
        {/* Blocked badge (#476/#855, ADR-0124 #1135) — the human flag, not the
            board's dependency-readiness signal. Shows the structured type chip +
            an age ("Xd Yh blocked") alongside the private reason (My Work is the
            assignee's own surface, so the reason is always theirs to read). */}
        {task.is_blocked && (
          <p className="mt-1 flex flex-wrap items-start gap-1.5 text-xs text-semantic-critical">
            <span
              className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-semibold
                bg-semantic-critical-bg border border-semantic-critical/40"
            >
              <span aria-hidden="true">●</span> <span>Blocked</span>
            </span>
            {task.blocker_type && (
              <span className="inline-flex shrink-0 items-center rounded px-1.5 py-0.5 font-medium
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
            'inline-flex h-7 min-w-[7rem] items-center justify-center gap-1 rounded',
            'border px-2 py-0.5 text-xs font-medium',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
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
