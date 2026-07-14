/**
 * The ratification tally + approve/reject affordance for one open ceiling-raise
 * proposal (ADR-0104 Amendment A / issue 930, issue 1260).
 *
 * The tally text is authoritative (`approve / threshold needed · eligible can vote`);
 * the dot row is a glance-able echo capped at the threshold (the bar to clear), not the
 * roster size. A non-team viewer (`can_vote === false`) sees the tally read-only — only
 * active team members ratify, never management (Amendment A.2).
 */

import type { CeilingProposal, CeilingVoteChoice } from './useSignalPrivacy';

interface CeilingVoteControlProps {
  proposal: CeilingProposal;
  /** True while this proposal's vote mutation is in flight (disables both buttons). */
  voting?: boolean;
  onVote: (choice: CeilingVoteChoice) => void;
}

export function CeilingVoteControl({ proposal, voting, onVote }: CeilingVoteControlProps) {
  const { approve_count, threshold, eligible_count, your_vote, can_vote } = proposal;
  // Dots echo progress toward the threshold (the floor to clear), not the whole roster.
  const filled = Math.min(approve_count, threshold);
  const remainingToPass = Math.max(threshold - approve_count, 0);

  return (
    <div className="mt-2">
      <div className="flex items-center gap-2 text-[12px] text-neutral-text-secondary">
        <span aria-hidden="true" className="tppm-mono tracking-tight">
          {'●'.repeat(filled)}
          {'○'.repeat(Math.max(threshold - filled, 0))}
        </span>
        <span>
          <span className="font-medium text-neutral-text-primary">
            {approve_count} / {threshold}
          </span>{' '}
          approvals needed · {eligible_count} can vote
        </span>
      </div>

      {/* A team member who has approved but the floor isn't reached yet — the
          lone-proposer / small-team case where a raise can't ratify alone. */}
      {can_vote && your_vote === 'approve' && remainingToPass > 0 && (
        <p className="mt-1 text-[12px] text-neutral-text-secondary">
          ⓘ Needs {remainingToPass} more teammate{remainingToPass === 1 ? '' : 's'} to approve before
          the ceiling lifts.
        </p>
      )}

      {can_vote ? (
        <div role="group" aria-label="Your vote" className="mt-2 flex gap-2">
          {(
            [
              { choice: 'approve' as const, label: 'Approve', on: 'bg-semantic-on-track text-white' },
              { choice: 'reject' as const, label: 'Reject', on: 'bg-semantic-critical text-white' },
            ] satisfies { choice: CeilingVoteChoice; label: string; on: string }[]
          ).map(({ choice, label, on }) => {
            const active = your_vote === choice;
            return (
              <button
                key={choice}
                type="button"
                aria-pressed={active}
                disabled={voting}
                onClick={() => onVote(choice)}
                className={[
                  'h-8 flex-1 rounded text-[12px] font-medium transition-colors disabled:cursor-not-allowed',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
                  active
                    ? on
                    : 'border border-neutral-border text-neutral-text-secondary hover:bg-neutral-surface-sunken',
                ].join(' ')}
              >
                {choice === 'approve' ? '✓ ' : '✗ '}
                {label}
              </button>
            );
          })}
        </div>
      ) : (
        <p className="mt-2 text-[12px] text-neutral-text-secondary">
          Only team members vote on this. {approve_count}/{threshold} approved so far.
        </p>
      )}
    </div>
  );
}
