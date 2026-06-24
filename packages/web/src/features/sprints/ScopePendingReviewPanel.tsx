import { useEffect, useRef, useState } from 'react';
import type { Task } from '@/types';
import { useScopeChangeActions } from '@/hooks/useScopeChangeActions';
import { useIterationLabel } from '@/hooks/useIterationLabel';

/**
 * Right slide-over for reviewing mid-sprint scope-injection pending items
 * (ADR-0102 §5, #881). Lists every task in the active sprint that is still
 * pending acceptance, with per-item Accept / Reject and a bulk
 * "Accept all" / "Reject all".
 *
 * Decision affordances are a PLANNING surface — this panel is only mounted from
 * the board banner and the Sprints view, gated by `useCanManageScope` at the
 * call site (the server is the real gate). It is never imported into the
 * contributor me tree (ADR-0102 §6 / frontend rule 151).
 *
 * Tone: pending is a neutral read-state (rule 149), so the panel chrome is
 * neutral — Accept is the primary (additive) action, Reject is a destructive
 * text action. Per #882 rule 150: accept = no undo (confirmation only); reject
 * is destructive, so the BULK reject goes through a confirm step. Reason fields
 * are never shown here and never gate proceeding (rule 139 carryover).
 */
interface PendingItem {
  /** Scope-change row id — the accept/reject target. */
  scopeChangeId: string;
  taskId: string;
  taskName: string;
  goalImpact: boolean;
}

interface Props {
  projectId: string;
  sprintId: string;
  /** Active-sprint tasks; the panel derives its list from the pending ones. */
  tasks: Task[];
  /** Disable controls (offline) — chips still render, but no action queues. */
  offline?: boolean;
  onClose: () => void;
}

function derivePending(tasks: Task[]): PendingItem[] {
  const items: PendingItem[] = [];
  for (const t of tasks) {
    if (!t.sprintPending) continue;
    // Use the most recent pending scope-change row for this task as the target.
    const pendingRow = (t.sprintScopeChanges ?? [])
      .filter((sc) => sc.status === 'pending' && sc.id)
      .at(-1);
    if (!pendingRow?.id) continue;
    items.push({
      scopeChangeId: pendingRow.id,
      taskId: t.id,
      taskName: t.name,
      goalImpact: pendingRow.goalImpact,
    });
  }
  return items;
}

export function ScopePendingReviewPanel({
  projectId,
  sprintId,
  tasks,
  offline = false,
  onClose,
}: Props) {
  const itl = useIterationLabel(projectId);
  const items = derivePending(tasks);
  const { acceptOne, rejectOne, acceptBulk, rejectBulk } = useScopeChangeActions(
    projectId,
    sprintId,
  );
  // #882 rule 150: bulk reject is destructive → confirm step. Bulk accept is
  // additive but still many-at-once, so it also gets a confirm (rule-1 carve-out).
  const [confirm, setConfirm] = useState<'accept-all' | 'reject-all' | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  // Esc closes; focus the close button on open (slide-over focus convention).
  useEffect(() => {
    closeBtnRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (confirm) setConfirm(null);
        else onClose();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, confirm]);

  const busy =
    acceptOne.isPending ||
    rejectOne.isPending ||
    acceptBulk.isPending ||
    rejectBulk.isPending;
  const controlsDisabled = offline || busy;
  const offlineTitle = offline
    ? "You're offline — accept and reject are unavailable until you reconnect."
    : undefined;

  function handleConfirmBulk() {
    if (confirm === 'accept-all') acceptBulk.mutate(undefined);
    else if (confirm === 'reject-all') rejectBulk.mutate(undefined);
    setConfirm(null);
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-neutral-text-primary/40">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="scope-review-title"
        className="w-full max-w-full sm:w-[400px] h-full bg-neutral-surface border-l border-neutral-border
          flex flex-col"
      >
        <header className="flex items-start justify-between gap-2 px-4 py-3 border-b border-neutral-border">
          <div>
            <h2 id="scope-review-title" className="text-sm font-semibold text-neutral-text-primary">
              Review pending scope
            </h2>
            <p className="mt-0.5 text-xs text-neutral-text-secondary">
              <span className="tppm-mono">{items.length}</span> item
              {items.length === 1 ? '' : 's'} added after the {itl.lower} started — not yet counted
              in the commitment.
            </p>
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            onClick={onClose}
            aria-label="Close scope review"
            className="shrink-0 w-8 h-8 inline-flex items-center justify-center rounded
              text-neutral-text-secondary hover:bg-neutral-surface-raised
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            ×
          </button>
        </header>

        <div className="flex-1 overflow-y-auto">
          {items.length === 0 ? (
            <p
              role="status"
              className="px-4 py-8 text-center text-xs text-neutral-text-secondary"
            >
              No items pending acceptance. Everything in this {itl.lower} is part of the commitment.
            </p>
          ) : (
            <ul className="divide-y divide-neutral-border/60">
              {items.map((item) => (
                <li key={item.scopeChangeId} className="flex items-center gap-2 px-4 py-2.5">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-neutral-text-primary truncate">
                      {item.taskName}
                    </p>
                    {item.goalImpact && (
                      <p className="text-xs text-neutral-text-secondary">Affects the {itl.lower} goal</p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => acceptOne.mutate(item.scopeChangeId)}
                    disabled={controlsDisabled}
                    title={offlineTitle}
                    aria-label={`Accept ${item.taskName} into the ${itl.lower}`}
                    className="shrink-0 h-7 px-2 rounded text-xs font-medium
                      border border-brand-primary/40 text-brand-primary hover:bg-brand-primary/10
                      disabled:opacity-50 disabled:cursor-not-allowed
                      focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    onClick={() => rejectOne.mutate(item.scopeChangeId)}
                    disabled={controlsDisabled}
                    title={offlineTitle}
                    aria-label={`Reject ${item.taskName} and remove it from the ${itl.lower}`}
                    className="shrink-0 h-7 px-2 rounded text-xs font-medium
                      text-semantic-critical hover:bg-semantic-critical-bg
                      disabled:opacity-50 disabled:cursor-not-allowed
                      focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-semantic-critical focus-visible:ring-offset-1"
                  >
                    Reject
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {items.length > 0 && (
          <footer className="flex items-center justify-end gap-2 px-4 py-3 border-t border-neutral-border">
            <button
              type="button"
              onClick={() => setConfirm('reject-all')}
              disabled={controlsDisabled}
              title={offlineTitle}
              className="h-8 px-3 rounded text-xs font-medium border border-semantic-critical/40
                text-semantic-critical hover:bg-semantic-critical-bg
                disabled:opacity-50 disabled:cursor-not-allowed
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-semantic-critical focus-visible:ring-offset-1"
            >
              Reject all
            </button>
            <button
              type="button"
              onClick={() => setConfirm('accept-all')}
              disabled={controlsDisabled}
              title={offlineTitle}
              className="h-8 px-3 rounded text-xs font-medium
                bg-brand-primary text-white hover:bg-brand-primary-dark
                disabled:opacity-50 disabled:cursor-not-allowed
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              Accept all
            </button>
          </footer>
        )}
      </div>

      {confirm && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="scope-bulk-confirm-title"
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-neutral-text-primary/40"
        >
          <div className="w-[400px] max-w-full rounded-card border border-neutral-border bg-neutral-surface flex flex-col gap-3 p-5">
            <h3
              id="scope-bulk-confirm-title"
              className="text-base font-semibold text-neutral-text-primary"
            >
              {confirm === 'accept-all'
                ? `Accept all ${items.length} pending item${items.length === 1 ? '' : 's'}?`
                : `Reject all ${items.length} pending item${items.length === 1 ? '' : 's'}?`}
            </h3>
            <p className="text-xs text-neutral-text-secondary">
              {confirm === 'accept-all'
                ? `They join the ${itl.lower} commitment and start counting toward burndown.`
                : `They are removed from the ${itl.lower}. You can re-add any of them afterward.`}
            </p>
            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setConfirm(null)}
                className="h-8 px-3 rounded text-xs font-medium border border-neutral-border
                  text-neutral-text-primary hover:bg-neutral-surface-raised
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmBulk}
                className={[
                  'h-8 px-3 rounded text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1',
                  confirm === 'accept-all'
                    ? 'bg-brand-primary text-white hover:bg-brand-primary-dark focus-visible:ring-brand-primary'
                    : 'border border-semantic-critical/40 text-semantic-critical hover:bg-semantic-critical-bg focus-visible:ring-semantic-critical',
                ].join(' ')}
              >
                {confirm === 'accept-all' ? 'Accept all' : 'Reject all'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
