/**
 * Inline "raise is pending team ratification" card for one signal's ladder row
 * (ADR-0104 Amendment A / issue 930, issue 1260) — Sarah's pending indicator.
 *
 * Rendered only when a signal has a live OPEN proposal. It is the persistent
 * confirmation that a facilitator's raise opened a ratification proposal (rather than
 * silently doing nothing), the place a team member casts their vote, and the proposer's
 * withdraw affordance. Identity is "you" + counts only — the backend exposes user ids,
 * not names, and naming voters would chill honest voting.
 */

import { useState } from 'react';
import { CeilingVoteControl } from './CeilingVoteControl';
import {
  AUDIENCE_RUNG_LABEL_FULL,
  type CeilingProposal,
  type CeilingVoteChoice,
} from './useSignalPrivacy';

interface CeilingProposalCardProps {
  proposal: CeilingProposal;
  signalTitle: string;
  /** The current user's id, used only to render "Proposed by you". */
  currentUserId?: string;
  /** Whether the viewer may withdraw (the proposer, or a facilitator/Admin). */
  canWithdraw: boolean;
  voting?: boolean;
  withdrawing?: boolean;
  onVote: (choice: CeilingVoteChoice) => void;
  onWithdraw: () => void;
}

/** Short "expires in 2 days" / "expires soon" / "expired" label for the OPEN window. */
function expiresLabel(expiresAt: string, now: number = Date.now()): string {
  const diff = new Date(expiresAt).getTime() - now;
  if (diff <= 0) return 'expired';
  const hours = Math.floor(diff / 3_600_000);
  if (hours < 1) return 'expires soon';
  if (hours < 24) return `expires in ${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(hours / 24);
  return `expires in ${days} day${days === 1 ? '' : 's'}`;
}

export function CeilingProposalCard({
  proposal,
  signalTitle,
  currentUserId,
  canWithdraw,
  voting,
  withdrawing,
  onVote,
  onWithdraw,
}: CeilingProposalCardProps) {
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const proposedByYou = currentUserId != null && proposal.proposed_by === currentUserId;

  return (
    <div
      className="mt-3 rounded-card border border-l-2 border-neutral-border border-l-semantic-warning bg-neutral-surface-raised p-3"
      aria-label={`Pending ceiling raise for ${signalTitle}`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="text-[12px] font-semibold text-neutral-text-primary">
          ⏳ Pending team decision
        </h4>
        <span className="tppm-mono text-[11px] text-neutral-text-secondary">
          {AUDIENCE_RUNG_LABEL_FULL[proposal.from_ceiling]} →{' '}
          {AUDIENCE_RUNG_LABEL_FULL[proposal.to_ceiling]}
        </span>
      </div>
      <p className="mt-0.5 text-[12px] text-neutral-text-secondary">
        {proposedByYou ? 'Proposed by you' : 'Proposed by a facilitator'} · {expiresLabel(proposal.expires_at)}
      </p>

      <CeilingVoteControl proposal={proposal} voting={voting} onVote={onVote} />

      {canWithdraw &&
        (confirmWithdraw ? (
          <div className="mt-3 flex items-center gap-2 text-[12px]">
            <span className="text-neutral-text-secondary">Withdraw this proposal?</span>
            <button
              type="button"
              disabled={withdrawing}
              onClick={() => {
                onWithdraw();
                setConfirmWithdraw(false);
              }}
              className="h-7 rounded border border-neutral-border px-3 font-medium text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:border-neutral-border/55 disabled:cursor-not-allowed"
            >
              Withdraw
            </button>
            <button
              type="button"
              onClick={() => setConfirmWithdraw(false)}
              className="h-7 rounded px-2 text-neutral-text-secondary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              Keep
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmWithdraw(true)}
            className="mt-3 rounded text-[12px] text-neutral-text-secondary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            Withdraw proposal
          </button>
        ))}
    </div>
  );
}
