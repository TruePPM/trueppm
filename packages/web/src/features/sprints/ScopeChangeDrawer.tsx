import { useEffect, useRef } from 'react';
import { useSprintScopeChanges, type ScopeChangeEvent } from '@/hooks/useSprints';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import { useFocusTrap } from '@/hooks/useFocusTrap';

interface Props {
  /** Sprint whose scope-change audit to show. */
  sprintId: string;
  onClose: () => void;
}

/**
 * Read-only mid-sprint scope-change audit drawer (#543/#550). The *visibility*
 * sibling of {@link ScopePendingReviewPanel}: that panel makes the accept/reject
 * decision; this one is the team-readable record of what changed — who added
 * what, when, the point delta, and the accept/reject outcome.
 *
 * Mounted from the persistent scope-change chip on the milestone surfaces (Gantt,
 * Overview, sprint workspace) and the SprintPanel "N added mid-sprint" badge, so
 * the team and the PM see the same audit from either side (Morgan parity). No
 * controls — it never mutates; aggregated points + ids only (no per-assignee).
 */
export function ScopeChangeDrawer({ sprintId, onClose }: Props) {
  const { data, isLoading } = useSprintScopeChanges(sprintId);
  const itl = useIterationLabel();
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  // Trap Tab inside the drawer; restore focus to the trigger on close (issue 1357).
  const trapRef = useFocusTrap<HTMLDivElement>(true);

  useEffect(() => {
    closeBtnRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const summary = data?.summary;
  const events = data?.events ?? [];

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-neutral-text-primary/40">
      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="scope-audit-title"
        tabIndex={-1}
        className="w-full max-w-full sm:w-[400px] h-full bg-neutral-surface border-l border-neutral-border flex flex-col focus:outline-none"
      >
        <header className="flex items-start justify-between gap-2 px-4 py-3 border-b border-neutral-border">
          <div>
            <h2 id="scope-audit-title" className="text-sm font-semibold text-neutral-text-primary">
              Scope changes
            </h2>
            {summary && (summary.points_added > 0 || summary.points_removed > 0) && (
              <p className="mt-0.5 text-xs text-neutral-text-secondary">
                <span className="tppm-mono text-semantic-at-risk">+{summary.points_added}</span>
                {' / '}
                <span className="tppm-mono text-semantic-on-track">−{summary.points_removed}</span>
                {' pts since activation'}
              </p>
            )}
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            onClick={onClose}
            aria-label="Close scope changes"
            className="shrink-0 rounded p-1 text-neutral-text-secondary hover:text-neutral-text-primary
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            <span aria-hidden="true" className="text-lg leading-none">×</span>
          </button>
        </header>

        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <p className="px-4 py-3 text-xs text-neutral-text-disabled">Loading scope changes…</p>
          ) : events.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs italic text-neutral-text-disabled">
              No scope changes since this {itl.lower} was activated.
            </p>
          ) : (
            <ul className="flex flex-col">
              {events.map((e) => (
                <ScopeChangeRow key={e.id} event={e} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

const STATUS_LABEL: Record<ScopeChangeEvent['status'], string> = {
  pending: 'Pending',
  accepted: 'Accepted',
  rejected: 'Removed',
};

function ScopeChangeRow({ event }: { event: ScopeChangeEvent }) {
  const itl = useIterationLabel();
  const removed = event.status === 'rejected';
  const points = event.story_points ?? 0;
  const when = new Date(event.added_at).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
  return (
    <li className="px-4 py-2.5 flex items-start gap-3 border-b border-neutral-border/60 last:border-b-0">
      <span
        className={`tppm-mono text-xs mt-0.5 shrink-0 ${
          removed ? 'text-semantic-on-track' : 'text-semantic-at-risk'
        }`}
        aria-label={`${removed ? 'removed' : 'added'} ${points} points`}
      >
        {removed ? '−' : '+'}
        {points}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-neutral-text-primary truncate" title={event.item_name}>
          {event.item_name}
          {event.goal_impact && (
            <span className="ml-1.5 align-middle text-xs text-semantic-at-risk" title={`Affects the ${itl.lower} goal`}>
              ◆
            </span>
          )}
        </p>
        <p className="text-xs text-neutral-text-secondary">
          {event.added_by_name ?? 'Someone'} · <span className="tppm-mono">{when}</span>
        </p>
      </div>
      <span
        className={`text-xs px-1.5 py-0.5 rounded shrink-0 ${
          event.status === 'pending'
            ? 'bg-neutral-surface-sunken text-neutral-text-secondary'
            : removed
              ? 'bg-semantic-on-track-bg text-semantic-on-track'
              : 'bg-semantic-at-risk-bg text-semantic-at-risk'
        }`}
      >
        {STATUS_LABEL[event.status]}
      </span>
    </li>
  );
}
