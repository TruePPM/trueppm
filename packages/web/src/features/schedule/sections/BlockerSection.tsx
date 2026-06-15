import { useMemo, useState } from 'react';

import { useScheduleTasks } from '@/hooks/useScheduleTasks';
import { useUpdateTask } from '@/hooks/useTaskMutations';
import {
  BLOCKER_TYPES,
  BLOCKER_TYPE_LABEL,
  blockerTypeLabel,
  formatBlockedAge,
} from '@/lib/blocker';
import type { DrawerSectionProps } from '@/lib/widget-registry';
import { canEditTask } from '@/lib/roles';

const LABEL_CLASS =
  'text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary mb-2';
const CONTROL_CLASS =
  'w-full rounded-control border border-neutral-border bg-neutral-surface px-3 py-2 ' +
  'text-sm text-neutral-text-primary placeholder:text-neutral-text-disabled ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1';

/**
 * Blocker — the human "I'm stuck" flag (ADR-0124), distinct from the
 * board's dependency-readiness `isBlocked`. The flag of record is
 * `blockedReason` (non-empty ⇒ flagged); `blocker_type` + the soft `blocking_task`
 * link are optional triage metadata, and `blocked_since`/`blocked_by`/age are
 * server-stamped. The free-text reason is private to the assignee + @-mentioned
 * (the server gates it out for everyone else — when that happens `blockedReason`
 * is `undefined` and we show a privacy notice instead of the text).
 *
 * `blocking_task` is a SOFT "waiting on" link, NOT a CPM dependency — it never
 * moves schedule dates; the UI labels it accordingly so a PM doesn't
 * mistake it for a real predecessor.
 */
export function BlockerSection({ taskId, projectId, userRole, canEdit }: DrawerSectionProps) {
  const { tasks } = useScheduleTasks();
  const task = tasks?.find((t) => t.id === taskId);
  const { mutate: updateTask, isPending } = useUpdateTask();

  // ADR-0133/#1142: gate write controls off the server-derived verdict; fall back to the client role rule only when absent.
  const editable = canEdit ?? canEditTask(userRole);

  const [formOpen, setFormOpen] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [type, setType] = useState<string | null>(null);
  const [blocking, setBlocking] = useState<string | null>(null);

  // Other tasks in the project, for the soft "waiting on" link picker.
  const linkOptions = useMemo(
    () => (tasks ?? []).filter((t) => t.id !== taskId).map((t) => ({ id: t.id, name: t.name })),
    [tasks, taskId],
  );

  if (!task) return null;

  const isFlagged = task.blockedAgeSeconds != null;
  const canReadReason = task.blockedReason !== undefined;

  // Draft values fall back to the persisted task; local edits override.
  const reasonDraft = reason ?? task.blockedReason ?? '';
  const typeDraft = type ?? task.blockerType ?? '';
  const blockingDraft = blocking ?? task.blockingTask ?? '';
  const age = formatBlockedAge(task.blockedAgeSeconds);

  function resetDrafts() {
    setReason(null);
    setType(null);
    setBlocking(null);
  }

  function flag() {
    if (!reasonDraft.trim()) return; // reason is the flag of record
    updateTask(
      {
        id: taskId,
        projectId,
        blocked_reason: reasonDraft.trim(),
        blocker_type: typeDraft,
        blocking_task: blockingDraft || null,
      },
      { onSuccess: () => { setFormOpen(false); resetDrafts(); } },
    );
  }

  function save() {
    updateTask(
      {
        id: taskId,
        projectId,
        ...(canReadReason ? { blocked_reason: reasonDraft } : {}),
        blocker_type: typeDraft,
        blocking_task: blockingDraft || null,
      },
      { onSuccess: resetDrafts },
    );
  }

  function unblock() {
    // Empty reason clears the flag; the server then clears type/link/stamps.
    updateTask({ id: taskId, projectId, blocked_reason: '' }, { onSuccess: resetDrafts });
  }

  const dirty =
    (canReadReason && reasonDraft !== (task.blockedReason ?? '')) ||
    typeDraft !== (task.blockerType ?? '') ||
    blockingDraft !== (task.blockingTask ?? '');

  // Shared editable controls (type picker + soft link) used in both states.
  const editableFields = (
    <>
      <div>
        <label htmlFor="blocker-type" className={LABEL_CLASS}>
          Type <span className="font-normal normal-case tracking-normal text-neutral-text-disabled">(optional)</span>
        </label>
        <select
          id="blocker-type"
          value={typeDraft}
          onChange={(e) => setType(e.target.value)}
          className={CONTROL_CLASS}
        >
          <option value="">No type</option>
          {BLOCKER_TYPES.map((t) => (
            <option key={t} value={t}>
              {BLOCKER_TYPE_LABEL[t]}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="blocker-link" className={LABEL_CLASS}>
          Related task{' '}
          <span className="font-normal normal-case tracking-normal text-neutral-text-disabled">
            (informational)
          </span>
        </label>
        <select
          id="blocker-link"
          value={blockingDraft}
          onChange={(e) => setBlocking(e.target.value)}
          className={CONTROL_CLASS}
        >
          <option value="">None</option>
          {linkOptions.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-neutral-text-secondary">
          A “waiting on” note. It does not move schedule dates — for that, add a dependency in the
          Dependencies section.
        </p>
      </div>
    </>
  );

  // Read-only "waiting on" link name for the read display (the soft link is
  // not shown in the team-visible summary chips, so surface it here as text).
  const blockingTaskName = task.blockingTask
    ? (linkOptions.find((o) => o.id === task.blockingTask)?.name ?? null)
    : null;

  // Non-editor view: the team-visible signals (badge / type / age / who flagged)
  // and the private reason (when readable) render, but no write control does.
  if (!editable) {
    return (
      <div className="space-y-4">
        {!isFlagged ? (
          <span className="text-sm text-neutral-text-secondary">Not blocked</span>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="inline-flex items-center rounded-chip bg-semantic-at-risk-bg px-2 py-0.5 text-xs font-medium text-semantic-at-risk">
                Blocked
              </span>
              {task.blockerType && (
                <span className="inline-flex items-center rounded-chip bg-neutral-surface-sunken px-2 py-0.5 text-xs text-neutral-text-secondary">
                  {blockerTypeLabel(task.blockerType)}
                </span>
              )}
              {age && <span className="tppm-mono text-xs text-neutral-text-secondary">{age}</span>}
              {task.blockedBy && (
                <span className="text-xs text-neutral-text-secondary">
                  flagged by {task.blockedBy.username}
                </span>
              )}
            </div>

            {canReadReason ? (
              <div>
                <div className={LABEL_CLASS}>Reason</div>
                <p className="text-sm text-neutral-text-primary whitespace-pre-wrap break-words">
                  {task.blockedReason}
                </p>
              </div>
            ) : (
              <p className="flex items-center gap-1.5 rounded-control border border-neutral-border bg-neutral-surface-sunken px-3 py-2 text-xs text-neutral-text-secondary">
                <span aria-hidden="true">🔒</span>
                The reason is private to the assignee and anyone they @mentioned.
              </p>
            )}

            {blockingTaskName && (
              <div>
                <div className={LABEL_CLASS}>Related task</div>
                <p className="text-sm text-neutral-text-primary">{blockingTaskName}</p>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {!isFlagged ? (
        formOpen ? (
          <div className="space-y-4">
            <div>
              <label htmlFor="blocker-reason" className={LABEL_CLASS}>
                Reason
              </label>
              <textarea
                id="blocker-reason"
                rows={3}
                value={reasonDraft}
                onChange={(e) => setReason(e.target.value)}
                placeholder="What's blocking this task?"
                className={CONTROL_CLASS}
              />
              <p className="mt-1 flex items-center gap-1 text-xs text-neutral-text-secondary">
                <span aria-hidden="true">🔒</span>
                Only you and anyone you @mention can read this. Your team sees the type, age, and who
                flagged it — never the reason.
              </p>
            </div>
            {editableFields}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={flag}
                disabled={!reasonDraft.trim() || isPending}
                className="rounded-control bg-sage-500 px-3 py-2 text-sm font-medium text-navy-900 border border-sage-600
                  disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:border-neutral-border/55 disabled:cursor-not-allowed
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy-700 focus-visible:ring-offset-1 focus-visible:ring-offset-sage-500"
              >
                Flag blocked
              </button>
              <button
                type="button"
                onClick={() => { setFormOpen(false); resetDrafts(); }}
                className="rounded-control border border-neutral-border px-3 py-2 text-sm text-neutral-text-primary
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-neutral-text-secondary">Not blocked</span>
            <button
              type="button"
              onClick={() => setFormOpen(true)}
              className="rounded-control border border-neutral-border px-3 py-2 text-sm font-medium text-neutral-text-primary
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              Flag as blocked
            </button>
          </div>
        )
      ) : (
        <div className="space-y-4">
          {/* Read-only flag summary — team-visible signals */}
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="inline-flex items-center rounded-chip bg-semantic-at-risk-bg px-2 py-0.5 text-xs font-medium text-semantic-at-risk">
              Blocked
            </span>
            {task.blockerType && (
              <span className="inline-flex items-center rounded-chip bg-neutral-surface-sunken px-2 py-0.5 text-xs text-neutral-text-secondary">
                {blockerTypeLabel(task.blockerType)}
              </span>
            )}
            {age && <span className="tppm-mono text-xs text-neutral-text-secondary">{age}</span>}
            {task.blockedBy && (
              <span className="text-xs text-neutral-text-secondary">
                flagged by {task.blockedBy.username}
              </span>
            )}
          </div>

          {/* Reason — editable for the assignee/@mentioned, private notice otherwise */}
          {canReadReason ? (
            <div>
              <label htmlFor="blocker-reason" className={LABEL_CLASS}>
                Reason
              </label>
              <textarea
                id="blocker-reason"
                rows={3}
                value={reasonDraft}
                onChange={(e) => setReason(e.target.value)}
                className={CONTROL_CLASS}
              />
              <p className="mt-1 flex items-center gap-1 text-xs text-neutral-text-secondary">
                <span aria-hidden="true">🔒</span>
                Only you and anyone you @mention can read this.
              </p>
            </div>
          ) : (
            <p className="flex items-center gap-1.5 rounded-control border border-neutral-border bg-neutral-surface-sunken px-3 py-2 text-xs text-neutral-text-secondary">
              <span aria-hidden="true">🔒</span>
              The reason is private to the assignee and anyone they @mentioned.
            </p>
          )}

          {editableFields}

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={save}
              disabled={!dirty || isPending}
              className="rounded-control bg-sage-500 px-3 py-2 text-sm font-medium text-navy-900 border border-sage-600
                disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:border-neutral-border/55 disabled:cursor-not-allowed
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy-700 focus-visible:ring-offset-1 focus-visible:ring-offset-sage-500"
            >
              Save changes
            </button>
            <button
              type="button"
              onClick={unblock}
              disabled={isPending}
              className="rounded-control border border-neutral-border px-3 py-2 text-sm text-neutral-text-primary
                disabled:cursor-not-allowed disabled:text-neutral-text-disabled
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              Unblock
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
