import { useEffect, useRef, useState } from 'react';
import { toast } from '@/components/Toast/toast';
import { CriticalDotIcon } from '@/components/Icons';
import { fmtUtcShort } from '@/lib/formatUtcDate';
import { ROLE_SCHEDULER } from '@/lib/roles';
import type { LinkType } from '@/types';
import {
  usePendingIncomingDeps,
  useResolvePendingDependency,
  type ExternalTaskCard,
  type PendingIncomingDep,
} from '@/hooks/useCrossProjectReview';

/**
 * Downstream consent affordance for pending cross-project dependencies
 * (ADR-0120 D2 / C2, issue 1480).
 *
 * When another team proposes a cross-project edge against one of *this*
 * project's tasks, the edge is created inert (`pending_acceptance`) and waits
 * for the successor (downstream) team to accept or reject it. This mounts on
 * the successor project's own schedule — their work surface — as a neutral
 * banner that opens a slide-over review panel. Each row shows the upstream
 * (blocking) task as the minimal D5 ExternalTaskCard (never team-private data)
 * and the reviewer's own affected task, with per-row Accept / Reject.
 *
 * Renders nothing when there is no project or nothing pending — so ScheduleView
 * wires it in with a single always-safe line. The server is the real gate
 * (Scheduler+ on the successor project); the buttons self-gate pessimistically
 * so a control that would 403 never shows as actionable.
 */
interface Props {
  projectId: string;
  /** The caller's role on this (successor) project; `null` while loading. */
  currentRole: number | null;
}

const DEP_TYPE_LABEL: Record<LinkType, string> = {
  FS: 'Finish → Start',
  SS: 'Start → Start',
  FF: 'Finish → Finish',
  SF: 'Start → Finish',
};

export function PendingCrossProjectReview({ projectId, currentRole }: Props) {
  const { items } = usePendingIncomingDeps(projectId);
  const [open, setOpen] = useState(false);

  // Nothing to review → no banner. Kept after the hook so hook order is stable.
  if (items.length === 0) return null;

  return (
    <>
      <div
        className="flex items-center gap-3 px-4 py-2 border-b border-neutral-border bg-neutral-surface-raised flex-shrink-0"
        role="status"
      >
        <p className="text-xs text-neutral-text-secondary">
          <span className="tppm-mono font-medium text-neutral-text-primary">{items.length}</span>{' '}
          cross-project {items.length === 1 ? 'link' : 'links'} from another team{' '}
          {items.length === 1 ? 'is' : 'are'} awaiting your review.
        </p>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="ml-auto shrink-0 h-7 px-3 rounded-control text-xs font-medium
            border border-brand-primary/40 text-brand-primary hover:bg-brand-primary/10
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        >
          Review
        </button>
      </div>
      {open && (
        <ReviewPanel projectId={projectId} currentRole={currentRole} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

function ReviewPanel({
  projectId,
  currentRole,
  onClose,
}: {
  projectId: string;
  currentRole: number | null;
  onClose: () => void;
}) {
  const { items } = usePendingIncomingDeps(projectId);
  const resolve = useResolvePendingDependency(projectId);
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  // Esc closes; focus the close button on open (slide-over focus convention).
  useEffect(() => {
    closeBtnRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Close once the last pending item clears (all reviewed).
  useEffect(() => {
    if (items.length === 0) onClose();
  }, [items.length, onClose]);

  // Scheduler+ on this successor project is the real (server) gate; mirror it
  // here so a control that would 403 never reads as actionable. `null` (role
  // still loading) stays disabled — a false affordance is worse than a delay.
  const canResolve = currentRole !== null && currentRole >= ROLE_SCHEDULER;
  const offline = typeof navigator !== 'undefined' && !navigator.onLine;
  const busy = resolve.isPending;
  const controlsDisabled = !canResolve || offline || busy;
  const disabledReason = !canResolve
    ? 'Only a Resource Manager or higher on this project can accept or reject cross-project links.'
    : offline
      ? "You're offline — accept and reject are unavailable until you reconnect."
      : undefined;

  function handleResolve(item: PendingIncomingDep, action: 'accept' | 'reject') {
    resolve.mutate(
      { id: item.id, action },
      {
        onSuccess: () => {
          if (action === 'accept') toast.success('Cross-project link accepted.');
          else toast.info('Cross-project link declined.');
        },
        onError: () => {
          toast.error(
            action === 'accept'
              ? "Couldn't accept the link. Try again."
              : "Couldn't decline the link. Try again.",
          );
        },
      },
    );
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-neutral-text-primary/40">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="xproj-review-title"
        className="w-full max-w-full sm:w-[420px] h-full bg-neutral-surface border-l border-neutral-border
          flex flex-col"
      >
        <header className="flex items-start justify-between gap-2 px-4 py-3 border-b border-neutral-border">
          <div>
            <h2 id="xproj-review-title" className="text-sm font-semibold text-neutral-text-primary">
              Review cross-project links
            </h2>
            <p className="mt-0.5 text-xs text-neutral-text-secondary">
              Another team proposed{' '}
              <span className="tppm-mono">{items.length}</span>{' '}
              {items.length === 1 ? 'link' : 'links'} to your tasks. Accepting binds the schedule
              across both projects.
            </p>
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            onClick={onClose}
            aria-label="Close cross-project review"
            className="shrink-0 w-8 h-8 inline-flex items-center justify-center rounded
              text-neutral-text-secondary hover:bg-neutral-surface-raised
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            ×
          </button>
        </header>

        {disabledReason && (
          <p className="px-4 py-2 text-xs text-neutral-text-secondary border-b border-neutral-border bg-neutral-surface-raised">
            {disabledReason}
          </p>
        )}

        <div className="flex-1 overflow-y-auto">
          <ul className="divide-y divide-neutral-border/60">
            {items.map((item) => (
              <li key={item.id} className="px-4 py-3">
                <ExternalCardRow card={item.predecessorCard} depType={item.depType} lag={item.lag} />
                {item.successorCard && (
                  <p className="mt-1.5 text-xs text-neutral-text-secondary">
                    Blocks your task{' '}
                    <span className="font-medium text-neutral-text-primary">
                      {item.successorCard.title}
                    </span>
                    {item.successorCard.hex_id && (
                      <span className="tppm-mono text-neutral-text-disabled">
                        {' '}
                        {item.successorCard.hex_id}
                      </span>
                    )}
                  </p>
                )}
                <div className="mt-2.5 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleResolve(item, 'accept')}
                    disabled={controlsDisabled}
                    title={disabledReason}
                    aria-label={`Accept cross-project link from ${item.predecessorCard?.title ?? 'upstream task'}`}
                    className="h-7 px-3 rounded-control text-xs font-medium
                      border border-brand-primary/40 text-brand-primary hover:bg-brand-primary/10
                      disabled:opacity-50 disabled:cursor-not-allowed
                      focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    onClick={() => handleResolve(item, 'reject')}
                    disabled={controlsDisabled}
                    title={disabledReason}
                    aria-label={`Decline cross-project link from ${item.predecessorCard?.title ?? 'upstream task'}`}
                    className="h-7 px-3 rounded-control text-xs font-medium
                      text-semantic-critical hover:bg-semantic-critical-bg
                      disabled:opacity-50 disabled:cursor-not-allowed
                      focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-semantic-critical focus-visible:ring-offset-1"
                  >
                    Decline
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

/**
 * One upstream task rendered as the D5 ExternalTaskCard — project identity
 * square + name, title, program-true CPM dates, and criticality. Scheduling
 * facts only; the payload carries nothing else and the row invents nothing.
 */
function ExternalCardRow({
  card,
  depType,
  lag,
}: {
  card: ExternalTaskCard | null;
  depType: LinkType;
  lag: number;
}) {
  if (!card) {
    // Defensive: a cross-project edge always carries the predecessor card, but
    // never crash the panel if a redaction path returns null.
    return (
      <p className="text-sm text-neutral-text-secondary italic">A task in another project</p>
    );
  }
  const initial = (card.project_name || '?').charAt(0).toUpperCase();
  return (
    <div className="flex items-start gap-2">
      <span
        aria-hidden="true"
        className="mt-0.5 shrink-0 w-5 h-5 inline-flex items-center justify-center rounded
          border border-neutral-border bg-neutral-surface-raised text-[10px] font-semibold text-neutral-text-secondary"
      >
        {initial}
      </span>
      <div className="min-w-0">
        <p className="text-sm font-medium text-neutral-text-primary truncate">
          {card.title}
          {card.hex_id && (
            <span className="tppm-mono text-neutral-text-disabled"> {card.hex_id}</span>
          )}
        </p>
        <p className="text-xs text-neutral-text-secondary truncate">in {card.project_name}</p>
        <p className="mt-1 text-xs text-neutral-text-secondary">
          {fmtUtcShort(card.early_start)} → {fmtUtcShort(card.early_finish)}
          <span className="text-neutral-text-disabled">
            {' · '}
            {DEP_TYPE_LABEL[depType]}
            {lag !== 0 && ` (${lag > 0 ? '+' : ''}${lag}d)`}
          </span>
        </p>
        {card.is_critical && (
          <p className="mt-1 flex items-center gap-1 text-xs font-medium text-semantic-critical">
            <CriticalDotIcon className="h-3 w-3" aria-hidden="true" />
            On critical path
          </p>
        )}
      </div>
    </div>
  );
}
