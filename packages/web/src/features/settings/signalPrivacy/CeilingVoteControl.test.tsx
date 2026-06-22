import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CeilingVoteControl } from './CeilingVoteControl';
import type { CeilingProposal } from './useSignalPrivacy';

function proposal(over: Partial<CeilingProposal> = {}): CeilingProposal {
  return {
    id: 'prop-1',
    signal: 'velocity',
    from_ceiling: 'team',
    to_ceiling: 'team_sm',
    status: 'open',
    proposed_by: 'user-1',
    created_at: '2026-06-21T00:00:00Z',
    expires_at: '2026-06-24T00:00:00Z',
    resolved_at: null,
    approve_count: 1,
    reject_count: 0,
    eligible_count: 3,
    threshold: 2,
    your_vote: null,
    can_vote: true,
    votes: [],
    ...over,
  };
}

describe('CeilingVoteControl', () => {
  it('renders the authoritative tally text', () => {
    render(<CeilingVoteControl proposal={proposal()} onVote={vi.fn()} />);
    expect(screen.getByText('1 / 2')).toBeInTheDocument();
    expect(screen.getByText(/3 can vote/)).toBeInTheDocument();
  });

  it('marks the chosen side pressed and dispatches the other on click', async () => {
    const user = userEvent.setup();
    const onVote = vi.fn();
    render(<CeilingVoteControl proposal={proposal({ your_vote: 'approve' })} onVote={onVote} />);
    expect(screen.getByRole('button', { name: /Approve/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(screen.getByRole('button', { name: /Reject/ }));
    expect(onVote).toHaveBeenCalledWith('reject');
  });

  it('hints that more approvals are needed once the viewer has approved (lone-proposer case)', () => {
    render(
      <CeilingVoteControl
        proposal={proposal({ approve_count: 1, threshold: 2, your_vote: 'approve' })}
        onVote={vi.fn()}
      />,
    );
    expect(screen.getByText(/Needs 1 more teammate to approve/)).toBeInTheDocument();
  });

  it('disables both buttons while a vote is in flight', () => {
    render(<CeilingVoteControl proposal={proposal()} voting onVote={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Approve/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Reject/ })).toBeDisabled();
  });

  it('shows a read-only tally and no vote buttons when the viewer cannot vote', () => {
    render(<CeilingVoteControl proposal={proposal({ can_vote: false })} onVote={vi.fn()} />);
    expect(screen.getByText(/Only team members vote on this/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Approve/ })).not.toBeInTheDocument();
  });
});
