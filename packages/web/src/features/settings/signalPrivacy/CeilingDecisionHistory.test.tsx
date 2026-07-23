import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { CeilingDecisionHistory } from './CeilingDecisionHistory';
import type { CeilingProposal } from './useSignalPrivacy';

// vi.hoisted so the mock is initialized before the (hoisted) vi.mock factory reads it.
const { useCeilingProposalsMock } = vi.hoisted(() => ({ useCeilingProposalsMock: vi.fn() }));

vi.mock('./useSignalPrivacy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./useSignalPrivacy')>();
  return { ...actual, useCeilingProposals: useCeilingProposalsMock };
});

function proposal(over: Partial<CeilingProposal> = {}): CeilingProposal {
  return {
    id: 'prop-1',
    signal: 'throughput_rollup',
    from_ceiling: 'team',
    to_ceiling: 'program_shared',
    status: 'ratified',
    proposed_by: 'user-1',
    created_at: '2026-06-10T00:00:00Z',
    expires_at: '2026-06-13T00:00:00Z',
    resolved_at: '2026-06-11T00:00:00Z',
    approve_count: 3,
    reject_count: 0,
    eligible_count: 5,
    threshold: 3,
    your_vote: 'approve',
    can_vote: true,
    votes: [],
    ...over,
  };
}

beforeEach(() => {
  useCeilingProposalsMock.mockReset();
  useCeilingProposalsMock.mockReturnValue({ data: [], isLoading: false });
});

describe('CeilingDecisionHistory', () => {
  it('is collapsed by default (the lazy query is not enabled)', () => {
    renderWithProviders(<CeilingDecisionHistory projectId="proj-1" />);
    const toggle = screen.getByRole('button', { name: /Decision history/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // enabled flag (2nd arg) is false until expanded.
    expect(useCeilingProposalsMock).toHaveBeenCalledWith('proj-1', false);
  });

  it('lists resolved decisions and hides still-open ones when expanded', async () => {
    const user = userEvent.setup();
    useCeilingProposalsMock.mockReturnValue({
      data: [
        proposal({ id: 'r1', status: 'ratified', signal: 'throughput_rollup' }),
        proposal({ id: 'x1', status: 'rejected', signal: 'pulse', to_ceiling: 'team_sm' }),
        proposal({ id: 'open1', status: 'open', signal: 'velocity' }),
      ],
      isLoading: false,
    });
    renderWithProviders(<CeilingDecisionHistory projectId="proj-1" />);
    await user.click(screen.getByRole('button', { name: /Decision history/ }));
    expect(screen.getByText('Ratified')).toBeInTheDocument();
    expect(screen.getByText('Rejected')).toBeInTheDocument();
    // Ratified/Rejected now lead with house CheckIcon/XMarkIcon SVGs (issue 1749), not glyphs.
    expect(screen.getByText('Ratified').querySelector('svg')).toBeInTheDocument();
    expect(screen.getByText('Rejected').querySelector('svg')).toBeInTheDocument();
    // The open one is shown inline on its ladder row, not in the audit tail.
    expect(screen.queryByText('Velocity')).not.toBeInTheDocument();
  });

  it('shows an empty note when there are no resolved decisions', async () => {
    const user = userEvent.setup();
    useCeilingProposalsMock.mockReturnValue({ data: [], isLoading: false });
    renderWithProviders(<CeilingDecisionHistory projectId="proj-1" />);
    await user.click(screen.getByRole('button', { name: /Decision history/ }));
    expect(screen.getByText('No ceiling decisions yet.')).toBeInTheDocument();
  });
});
