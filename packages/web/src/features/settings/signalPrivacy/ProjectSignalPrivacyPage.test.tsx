import { screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { ProjectSignalPrivacyPage } from './ProjectSignalPrivacyPage';
import type { CeilingProposal, SignalKey, SignalPrivacyPolicy } from './useSignalPrivacy';

const setAudienceMutate = vi.fn();
const raiseCeilingMutate = vi.fn();
const ratchetMutate = vi.fn();
const voteMutate = vi.fn();
const withdrawMutate = vi.fn();

vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => 'proj-1' }));
// Deterministic identity for "Proposed by you" without an /auth/me/ round-trip.
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: { id: 'user-alice' }, isLoading: false }),
}));

const policyHolder = { data: null as SignalPrivacyPolicy | null };

vi.mock('./useSignalPrivacy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./useSignalPrivacy')>();
  return {
    ...actual,
    useSignalPrivacy: () => ({
      data: policyHolder.data,
      isLoading: false,
      isError: false,
    }),
    // The Decision-history section is collapsed by default, so it never queries here.
    useCeilingProposals: () => ({ data: [], isLoading: false }),
    useSignalPrivacyMutations: () => ({
      setAudience: {
        mutate: setAudienceMutate,
        isPending: false,
        isError: false,
        variables: undefined,
      },
      raiseCeiling: {
        mutate: raiseCeilingMutate,
        isPending: false,
        isError: false,
        variables: undefined,
      },
      ratchetDown: { mutate: ratchetMutate, isPending: false, isError: false },
      voteOnProposal: {
        mutate: voteMutate,
        isPending: false,
        isError: false,
        error: null,
        variables: undefined,
      },
      withdrawProposal: {
        mutate: withdrawMutate,
        isPending: false,
        isError: false,
        error: null,
        variables: undefined,
      },
    }),
  };
});

function proposal(signal: SignalKey, over: Partial<CeilingProposal> = {}): CeilingProposal {
  return {
    id: `prop-${signal}`,
    signal,
    from_ceiling: 'team',
    to_ceiling: 'team_sm',
    status: 'open',
    proposed_by: 'user-alice',
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

function policy(over: Partial<SignalPrivacyPolicy> = {}): SignalPrivacyPolicy {
  return {
    signals: {
      velocity: { audience: 'team', ceiling: 'team' },
      throughput_rollup: { audience: 'team', ceiling: 'program_shared' },
      pulse: { audience: 'team', ceiling: 'team' },
    },
    requester_tier: 'team_sm_pm',
    can_set_audience: true,
    can_raise_ceiling: true,
    can_vote: true,
    open_proposals: {},
    ...over,
  };
}

beforeEach(() => {
  setAudienceMutate.mockClear();
  raiseCeilingMutate.mockClear();
  ratchetMutate.mockClear();
  voteMutate.mockClear();
  withdrawMutate.mockClear();
  policyHolder.data = policy();
});

describe('ProjectSignalPrivacyPage', () => {
  it('renders the three signal ladders', () => {
    renderWithRouter(<ProjectSignalPrivacyPage />);
    expect(screen.getByRole('radiogroup', { name: 'Velocity audience' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Retro pulse audience' })).toBeInTheDocument();
  });

  it('spells out the SM/PM rungs as visible text and accessible name (#975)', () => {
    policyHolder.data = policy();
    renderWithRouter(<ProjectSignalPrivacyPage />);
    const group = screen.getByRole('radiogroup', { name: 'Throughput rollup audience' });
    // Full names are the rungs' accessible names (the SR/hover signal)…
    expect(within(group).getByRole('radio', { name: 'Scrum Master' })).toBeInTheDocument();
    expect(within(group).getByRole('radio', { name: 'Project Manager' })).toBeInTheDocument();
    // …and are rendered as visible text, not the ambiguous "SM"/"PM".
    expect(within(group).getByText('Scrum Master')).toBeInTheDocument();
    expect(within(group).getByText('Project Manager')).toBeInTheDocument();
  });

  it('sets the audience when an unlocked rung is clicked', async () => {
    const user = userEvent.setup();
    // throughput ceiling is program_shared, so its Scrum Master rung is unlocked.
    policyHolder.data = policy();
    renderWithRouter(<ProjectSignalPrivacyPage />);
    const group = screen.getByRole('radiogroup', { name: 'Throughput rollup audience' });
    // Rung accessible name is the spelled-out label, never the bare "SM" (#975).
    await user.click(within(group).getByRole('radio', { name: 'Scrum Master' }));
    expect(setAudienceMutate).toHaveBeenCalledWith({
      signal: 'throughput_rollup',
      audience: 'team_sm',
    });
  });

  it('opens the team-decision dialog for a raise, then confirms', async () => {
    const user = userEvent.setup();
    renderWithRouter(<ProjectSignalPrivacyPage />);
    // Velocity ceiling is team → "Raise ceiling…" is offered.
    const velocityRow = screen
      .getByRole('radiogroup', { name: 'Velocity audience' })
      .closest('li')!;
    await user.click(within(velocityRow).getByRole('button', { name: /Raise ceiling/ }));
    // In-flow confirmation panel is a labeled group, not a focus-trapping alertdialog.
    expect(screen.getByRole('group', { name: /Raise the ceiling for/ })).toBeInTheDocument();
    expect(raiseCeilingMutate).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Raise ceiling' }));
    expect(raiseCeilingMutate).toHaveBeenCalledWith(
      expect.objectContaining({ signal: 'velocity' }),
    );
  });

  it('ratchets everything to team-only via a confirm', async () => {
    const user = userEvent.setup();
    policyHolder.data = policy({
      signals: {
        velocity: { audience: 'team_sm', ceiling: 'team_sm_pm' },
        throughput_rollup: { audience: 'team', ceiling: 'program_shared' },
        pulse: { audience: 'team', ceiling: 'team' },
      },
    });
    renderWithRouter(<ProjectSignalPrivacyPage />);
    await user.click(screen.getByRole('button', { name: 'Make everything team-only' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(ratchetMutate).toHaveBeenCalled();
  });

  it('switches to the read-only matrix lens', async () => {
    const user = userEvent.setup();
    renderWithRouter(<ProjectSignalPrivacyPage />);
    await user.click(screen.getByRole('tab', { name: 'Who sees what' }));
    expect(screen.getByRole('table')).toBeInTheDocument();
  });

  it('is read-only for a non-facilitator (no ladder controls, banner shown)', () => {
    policyHolder.data = policy({
      can_set_audience: false,
      can_raise_ceiling: false,
      requester_tier: 'team',
    });
    renderWithRouter(<ProjectSignalPrivacyPage />);
    expect(screen.getByText(/Only the Scrum Master can change signal privacy/)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Make everything team-only' }),
    ).not.toBeInTheDocument();
  });

  describe('pending ceiling-raise proposal', () => {
    it('shows the pending card with tally and proposer when a raise is open', () => {
      policyHolder.data = policy({ open_proposals: { velocity: proposal('velocity') } });
      renderWithRouter(<ProjectSignalPrivacyPage />);
      const card = screen.getByLabelText('Pending ceiling raise for Velocity');
      expect(within(card).getByText('⏳ Pending team decision')).toBeInTheDocument();
      // 1 of 2 approvals needed, 3 can vote — and the proposer is the current user.
      expect(within(card).getByText('1 / 2')).toBeInTheDocument();
      expect(within(card).getByText(/3 can vote/)).toBeInTheDocument();
      expect(within(card).getByText(/Proposed by you/)).toBeInTheDocument();
    });

    it('casts an approve vote for the open proposal', async () => {
      const user = userEvent.setup();
      policyHolder.data = policy({ open_proposals: { velocity: proposal('velocity') } });
      renderWithRouter(<ProjectSignalPrivacyPage />);
      const card = screen.getByLabelText('Pending ceiling raise for Velocity');
      await user.click(within(card).getByRole('button', { name: /Approve/ }));
      expect(voteMutate).toHaveBeenCalledWith({ proposalId: 'prop-velocity', choice: 'approve' });
    });

    it('withdraws the proposal through the inline confirm', async () => {
      const user = userEvent.setup();
      policyHolder.data = policy({ open_proposals: { velocity: proposal('velocity') } });
      renderWithRouter(<ProjectSignalPrivacyPage />);
      const card = screen.getByLabelText('Pending ceiling raise for Velocity');
      await user.click(within(card).getByRole('button', { name: 'Withdraw proposal' }));
      await user.click(within(card).getByRole('button', { name: 'Withdraw' }));
      expect(withdrawMutate).toHaveBeenCalledWith({ proposalId: 'prop-velocity' });
    });

    it('blocks opening a second raise while one is pending for that signal', () => {
      policyHolder.data = policy({ open_proposals: { velocity: proposal('velocity') } });
      renderWithRouter(<ProjectSignalPrivacyPage />);
      const velocityRow = screen
        .getByRole('radiogroup', { name: 'Velocity audience' })
        .closest('li')!;
      expect(within(velocityRow).getByRole('button', { name: /Raise ceiling/ })).toBeDisabled();
    });

    it('shows a read-only tally to a non-team viewer (no vote buttons)', () => {
      policyHolder.data = policy({
        can_vote: false,
        open_proposals: { velocity: proposal('velocity', { can_vote: false }) },
      });
      renderWithRouter(<ProjectSignalPrivacyPage />);
      const card = screen.getByLabelText('Pending ceiling raise for Velocity');
      expect(within(card).getByText(/Only team members vote on this/)).toBeInTheDocument();
      expect(within(card).queryByRole('button', { name: /Approve/ })).not.toBeInTheDocument();
    });
  });
});
