import { useEffect, useMemo, useRef, useState } from 'react';
import { useUserDateFormat } from '@/hooks/useUserDateFormat';
import {
  useSprintScopeChanges,
  useSprintDurationChanges,
  type ScopeChangeEvent,
  type SprintDurationChangeEvent,
} from '@/hooks/useSprints';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { useCanManageScope } from '@/hooks/useCanManageScope';
import { useSlipDecision } from '@/hooks/useScopeChangeActions';
import { RepeatIcon, TargetIcon } from '@/components/Icons';

/** A scope-change and a duration-change row, merged into one time-sorted feed. */
type FeedItem =
  | { kind: 'scope'; at: string; event: ScopeChangeEvent }
  | { kind: 'duration'; at: string; event: SprintDurationChangeEvent };

interface Props {
  /** Sprint whose scope-change audit to show. */
  sprintId: string;
  /** The sprint's project. Needed to offer the slip decision controls; without it
   *  the drawer stays read-only. */
  projectId?: string;
  onClose: () => void;
}

/** What a pending slip row needs to offer its decision controls. */
interface SlipDecisionProps {
  /** The drawer's one decision mutation, shared by every pending row. */
  decide: ReturnType<typeof useSlipDecision>;
  /** Pending rows sharing this row's `batch_id`, when this row leads the batch. */
  batchSize: number;
}

/**
 * Read-only mid-sprint scope-change audit drawer (#543/#550). The *visibility*
 * sibling of {@link ScopePendingReviewPanel}: that panel makes the accept/reject
 * decision; this one is the team-readable record of what changed — who added
 * what, when, the point delta, and the accept/reject outcome.
 *
 * Mounted from the persistent scope-change chip on the milestone surfaces (Gantt,
 * Overview, sprint workspace) and the SprintPanel "N added mid-sprint" badge, so
 * the team and the PM see the same audit from either side (Morgan parity).
 * Aggregated points + ids only (no per-assignee). The one control: a PENDING
 * commitment slip (ADR-1485 D1) has no other decide surface, so its row offers
 * Accept / Reject (and the whole batch) to an accept-authority holder.
 */
export function ScopeChangeDrawer({ sprintId, projectId, onClose }: Props) {
  const canDecide = useCanManageScope(projectId) && !!projectId;
  const { data, isLoading } = useSprintScopeChanges(sprintId);
  const { data: durationData, isLoading: durationLoading } = useSprintDurationChanges(sprintId);
  const itl = useIterationLabel();
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  // One mutation for the whole drawer, so its pending flag can key the trap.
  const decide = useSlipDecision(projectId, sprintId);
  // Trap Tab inside the drawer; restore focus to the trigger on close (issue 1357).
  // A decision in flight disables the Accept / Reject buttons, which blurs the
  // one just pressed to <body>; the pending flag as focusKey re-seats focus
  // inside the drawer (web rule 362).
  const trapRef = useFocusTrap<HTMLDivElement>(true, undefined, decide.isPending);

  useEffect(() => {
    closeBtnRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const summary = data?.summary;

  // Merge scope-changes and duration-changes into one newest-first feed so the
  // team scans a single chronological log (ADR-0151, issue 1254). Both are
  // read-only audit rows; they differ only by icon/accent, not by section.
  const feed: FeedItem[] = useMemo(() => {
    const scopeEvents = data?.events ?? [];
    const durationEvents = durationData?.events ?? [];
    const items: FeedItem[] = [
      ...scopeEvents.map((e): FeedItem => ({ kind: 'scope', at: e.added_at, event: e })),
      ...durationEvents.map((e): FeedItem => ({ kind: 'duration', at: e.created_at, event: e })),
    ];
    return items.sort((a, b) => b.at.localeCompare(a.at));
  }, [data?.events, durationData?.events]);

  const loading = isLoading || durationLoading;

  // The first pending slip of each batch carries the batch controls; the count is
  // how many pending rows that batch holds.
  const batchLead = useMemo(() => {
    const sizes = new Map<string, number>();
    const lead = new Map<string, string>();
    for (const e of data?.events ?? []) {
      if (e.kind !== 'slip' || e.status !== 'pending' || !e.batch_id) continue;
      sizes.set(e.batch_id, (sizes.get(e.batch_id) ?? 0) + 1);
      if (!lead.has(e.batch_id)) lead.set(e.batch_id, e.id);
    }
    return { sizes, lead };
  }, [data?.events]);

  function slipDecision(event: ScopeChangeEvent): SlipDecisionProps | undefined {
    if (!canDecide || !projectId || event.kind !== 'slip' || event.status !== 'pending') {
      return undefined;
    }
    const leads = event.batch_id ? batchLead.lead.get(event.batch_id) === event.id : false;
    const batchSize = leads && event.batch_id ? (batchLead.sizes.get(event.batch_id) ?? 0) : 0;
    return { decide, batchSize };
  }

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
            <span aria-hidden="true" className="text-lg leading-none">
              ×
            </span>
          </button>
        </header>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <p className="px-4 py-3 text-xs text-neutral-text-disabled">Loading changes…</p>
          ) : feed.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs italic text-neutral-text-disabled">
              No changes since this {itl.lower} was activated.
            </p>
          ) : (
            <ul className="flex flex-col">
              {feed.map((item) =>
                item.kind === 'scope' ? (
                  <ScopeChangeRow
                    key={`scope-${item.event.id}`}
                    event={item.event}
                    decision={slipDecision(item.event)}
                  />
                ) : (
                  <DurationChangeRow key={`duration-${item.event.id}`} event={item.event} />
                ),
              )}
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

const SLIP_STATUS_LABEL: Record<ScopeChangeEvent['status'], string> = {
  pending: 'Pending',
  accepted: 'Accepted',
  rejected: 'Not applied',
};

/**
 * A commitment-slip row (ADR-1485 D1): a proposed date move on work already
 * committed to the sprint. It adds and removes no scope, so it carries no ± points
 * accent and is never labeled an addition.
 */
function SlipRow({ event, decision }: { event: ScopeChangeEvent; decision?: SlipDecisionProps }) {
  const { formatInstantDate, fmtDateShort } = useUserDateFormat();
  const when = formatInstantDate(event.added_at, 'short');
  return (
    <li
      className="px-4 py-2.5 flex items-start gap-3 border-b border-neutral-border/60 last:border-b-0"
      data-testid="slip-row"
    >
      <span className="text-xs mt-0.5 shrink-0 text-neutral-text-secondary" aria-hidden="true">
        →
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-neutral-text-primary truncate" title={event.item_name}>
          {event.item_name}
        </p>
        <p className="text-xs text-neutral-text-secondary">
          Date slip
          {event.proposed_finish ? (
            <>
              {' '}
              to <span className="tppm-mono">{fmtDateShort(event.proposed_finish)}</span>
            </>
          ) : null}{' '}
          · {event.added_by_name ?? 'Someone'} · <span className="tppm-mono">{when}</span>
        </p>
        {/* A direct slip stores one reason as both; say it once. */}
        {event.reason && event.reason !== event.decision_reason ? (
          <p className="text-xs text-neutral-text-secondary break-words">
            Requester&apos;s reason: {event.reason}
          </p>
        ) : null}
        {event.decision_reason ? (
          <p className="text-xs text-neutral-text-secondary">{event.decision_reason}</p>
        ) : null}
        {decision ? <SlipDecisionControls event={event} {...decision} /> : null}
      </div>
      <span className="text-xs px-1.5 py-0.5 rounded shrink-0 bg-neutral-surface-sunken text-neutral-text-secondary">
        {SLIP_STATUS_LABEL[event.status]}
      </span>
    </li>
  );
}

const DECIDE_BTN =
  'h-8 px-3 rounded text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1';
const ACCEPT_BTN = `${DECIDE_BTN} bg-brand-primary text-neutral-text-inverse hover:bg-brand-primary-dark focus-visible:ring-brand-primary`;
const REJECT_BTN = `${DECIDE_BTN} border border-semantic-critical/40 text-semantic-critical hover:bg-semantic-critical-bg focus-visible:ring-semantic-critical`;

/**
 * Accept / Reject for one PENDING slip, and for its whole batch when this row
 * leads a batch of more than one (ADR-1485 D1). The reason is optional; it is
 * stored on the row as the decision reason.
 */
function SlipDecisionControls({
  event,
  decide,
  batchSize,
}: { event: ScopeChangeEvent } & SlipDecisionProps) {
  const [reason, setReason] = useState('');
  const busy = decide.isPending;
  const reasonId = `slip-reason-${event.id}`;
  const showBatch = batchSize > 1 && !!event.batch_id;
  return (
    <div className="mt-2 flex flex-col gap-2">
      <label htmlFor={reasonId} className="sr-only">
        Reason for the decision on {event.item_name} (optional)
      </label>
      <input
        id={reasonId}
        type="text"
        maxLength={500}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason (optional)"
        className="h-8 w-full rounded border border-neutral-border bg-neutral-surface px-2 text-xs
          text-neutral-text-primary placeholder:text-neutral-text-disabled
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
      />
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => decide.mutate({ accept: true, id: event.id, reason })}
          aria-label={`Accept the date change for ${event.item_name}`}
          className={ACCEPT_BTN}
        >
          Accept
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => decide.mutate({ accept: false, id: event.id, reason })}
          aria-label={`Reject the date change for ${event.item_name}`}
          className={REJECT_BTN}
        >
          Reject
        </button>
        {showBatch ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                decide.mutate({ accept: true, batchId: event.batch_id ?? undefined, reason })
              }
              className={ACCEPT_BTN}
            >
              Accept all {batchSize}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                decide.mutate({ accept: false, batchId: event.batch_id ?? undefined, reason })
              }
              className={REJECT_BTN}
            >
              Reject all {batchSize}
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}

function ScopeChangeRow({
  event,
  decision,
}: {
  event: ScopeChangeEvent;
  decision?: SlipDecisionProps;
}) {
  const { formatInstantDate } = useUserDateFormat();
  const itl = useIterationLabel();
  if (event.kind === 'slip') return <SlipRow event={event} decision={decision} />;
  const removed = event.status === 'rejected';
  const points = event.story_points ?? 0;
  const when = formatInstantDate(event.added_at, 'short');
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
            <span
              className="ml-1.5 align-middle text-xs text-semantic-at-risk"
              title={`Affects the ${itl.lower} goal`}
            >
              <TargetIcon aria-hidden="true" className="inline-block h-3 w-3 align-[-0.125em]" />
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

/**
 * A mid-sprint duration-change row (ADR-0151, issue 1254). Read-only, interleaved
 * with scope-change rows in the same feed; distinguished by an info-blue
 * circular-arrow glyph (vs the scope rows' amber ± accent) so the two are
 * separable by shape and color (WCAG 1.4.1). The "% recalculated" line appears
 * only when the policy prorated the value (percent_complete_after set).
 */
function DurationChangeRow({ event }: { event: SprintDurationChangeEvent }) {
  const { formatInstantDate } = useUserDateFormat();
  const when = formatInstantDate(event.created_at, 'short');
  const recalculated =
    event.percent_complete_after !== null &&
    event.percent_complete_after !== event.percent_complete_at_change;
  return (
    <li
      className="px-4 py-2.5 flex items-start gap-3 border-b border-neutral-border/60 last:border-b-0"
      data-testid="duration-change-row"
    >
      <span className="text-xs mt-0.5 shrink-0 text-brand-primary" aria-label="duration changed">
        <RepeatIcon aria-hidden="true" className="inline-block h-3 w-3 align-[-0.125em]" />
      </span>
      <div className="flex-1 min-w-0">
        <p
          className="text-sm text-neutral-text-primary truncate"
          title={event.task_name ?? undefined}
        >
          {event.task_name ?? 'Task'}
          {' · '}
          <span className="tppm-mono text-neutral-text-secondary">
            Duration {event.old_duration}d → {event.new_duration}d
          </span>
        </p>
        {recalculated && (
          <p className="text-xs text-neutral-text-secondary">
            % complete recalculated{' '}
            <span className="tppm-mono">
              {Math.round(event.percent_complete_at_change)}% →{' '}
              {Math.round(event.percent_complete_after as number)}%
            </span>
          </p>
        )}
        <p className="text-xs text-neutral-text-secondary">
          {event.actor_name ?? 'Automatic'} · <span className="tppm-mono">{when}</span>
        </p>
      </div>
    </li>
  );
}
