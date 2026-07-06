import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { useScheduleTasks } from '@/hooks/useScheduleTasks';
import { useUpdateTask } from '@/hooks/useTaskMutations';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import {
  BLOCKER_TYPES,
  BLOCKER_TYPE_LABEL,
  blockerTypeLabel,
  formatBlockedAge,
  SOFT_LINK_CAVEAT,
  SOFT_LINK_CAVEAT_SHORT,
} from '@/lib/blocker';
import type { DrawerSectionProps } from '@/lib/widget-registry';
import { canEditTask } from '@/lib/roles';
import { queueOfflineBlocker } from '@/features/blocker/offline/useBlockerOffline';
import {
  useBlockerPendingOp,
  useBlockerSyncedSignal,
} from '@/features/blocker/offline/blockerOutboxStore';
import { BlockerPendingBadge } from '@/features/blocker/BlockerPendingBadge';

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

  // ADR-0133/1142: gate write controls off the server-derived verdict; fall back to the client role rule only when absent.
  const editable = canEdit ?? canEditTask(userRole);

  // Offline blocker write path (ADR-0247): when offline, flag/save/unblock queue a
  // durable write instead of a failing live PATCH — the field-PM's #1 no-signal action.
  const online = useOnlineStatus();
  const queryClient = useQueryClient();
  const pendingOp = useBlockerPendingOp(taskId);
  const syncedAt = useBlockerSyncedSignal(taskId);

  const [formOpen, setFormOpen] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [type, setType] = useState<string | null>(null);
  const [blocking, setBlocking] = useState<string | null>(null);

  // Live-region text: announced once when a write is queued, and once when a
  // queued write later syncs (the flush sets `lastSynced` only on success, so a
  // 409 conflict — which shows its own toast — never triggers a false "synced").
  const [announcement, setAnnouncement] = useState('');
  const lastAnnouncedSync = useRef(syncedAt);
  useEffect(() => {
    if (syncedAt != null && syncedAt !== lastAnnouncedSync.current) {
      setAnnouncement('Blocker synced.');
    }
    lastAnnouncedSync.current = syncedAt;
  }, [syncedAt]);

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

  // A fresh offline flag has no server-stamped age yet — show "queued", not a fake
  // duration; an offline edit to an already-flagged task keeps the real age. A
  // queued unblock optimistically clears the row, so its badge rides the affordance.
  const freshQueuedFlag = pendingOp?.kind === 'flag' && !pendingOp.wasFlagged;
  const pendingUnblock = pendingOp?.kind === 'unblock';

  function resetDrafts() {
    setReason(null);
    setType(null);
    setBlocking(null);
  }

  function flag() {
    if (!reasonDraft.trim()) return; // reason is the flag of record
    if (!online) {
      // Offline: queue the flag and optimistically show it as blocked (ADR-0247).
      queueOfflineBlocker(queryClient, {
        projectId,
        taskId,
        kind: 'flag',
        reason: reasonDraft.trim(),
        blockerType: typeDraft,
        blockingTask: blockingDraft || null,
      });
      setAnnouncement('Blocker flagged. Queued — it will sync when you reconnect.');
      setFormOpen(false);
      resetDrafts();
      return;
    }
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
    if (!online) {
      // `reason: null` when the caller can't read the private reason — a type/link
      // edit must not overwrite the stored reason it never saw.
      queueOfflineBlocker(queryClient, {
        projectId,
        taskId,
        kind: 'flag',
        reason: canReadReason ? reasonDraft : null,
        blockerType: typeDraft,
        blockingTask: blockingDraft || null,
      });
      setAnnouncement('Blocker changes queued — they will sync when you reconnect.');
      resetDrafts();
      return;
    }
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
    if (!online) {
      queueOfflineBlocker(queryClient, {
        projectId,
        taskId,
        kind: 'unblock',
        reason: '',
        blockerType: '',
        blockingTask: null,
      });
      setAnnouncement('Unblock queued — it will sync when you reconnect.');
      resetDrafts();
      return;
    }
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
        <p className="mt-1 text-xs text-neutral-text-secondary">{SOFT_LINK_CAVEAT}</p>
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
                <p className="mt-1 text-xs text-neutral-text-secondary">{SOFT_LINK_CAVEAT_SHORT}</p>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Announces queued/synced blocker writes to assistive tech (WCAG 4.1.3). */}
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
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
            {!online && (
              <p className="text-xs text-neutral-text-secondary">
                Offline — this will be saved and synced when you reconnect.
              </p>
            )}
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="text-sm text-neutral-text-secondary">Not blocked</span>
              {/* A queued unblock optimistically cleared the row; keep its sync state visible. */}
              {pendingUnblock && <BlockerPendingBadge kind="unblock" />}
            </div>
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
            {freshQueuedFlag ? (
              // No server-stamped age yet — the pending badge carries the sync state.
              <span className="text-xs text-neutral-text-secondary">queued</span>
            ) : (
              age && <span className="tppm-mono text-xs text-neutral-text-secondary">{age}</span>
            )}
            {task.blockedBy && (
              <span className="text-xs text-neutral-text-secondary">
                flagged by {task.blockedBy.username}
              </span>
            )}
            {pendingOp && <BlockerPendingBadge kind={pendingOp.kind} compact />}
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
          {!online && (
            <p className="text-xs text-neutral-text-secondary">
              Offline — changes will be saved and synced when you reconnect.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
