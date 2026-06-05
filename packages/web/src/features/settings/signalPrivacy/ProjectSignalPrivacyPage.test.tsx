import { screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { ProjectSignalPrivacyPage } from './ProjectSignalPrivacyPage';
import type { SignalPrivacyPolicy } from './useSignalPrivacy';

const setAudienceMutate = vi.fn();
const raiseCeilingMutate = vi.fn();
const ratchetMutate = vi.fn();

vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => 'proj-1' }));

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
    useSignalPrivacyMutations: () => ({
      setAudience: { mutate: setAudienceMutate, isPending: false, isError: false, variables: undefined },
      raiseCeiling: { mutate: raiseCeilingMutate, isPending: false, isError: false, variables: undefined },
      ratchetDown: { mutate: ratchetMutate, isPending: false, isError: false },
    }),
  };
});

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
    ...over,
  };
}

beforeEach(() => {
  setAudienceMutate.mockClear();
  raiseCeilingMutate.mockClear();
  ratchetMutate.mockClear();
  policyHolder.data = policy();
});

describe('ProjectSignalPrivacyPage', () => {
  it('renders the three signal ladders', () => {
    renderWithRouter(<ProjectSignalPrivacyPage />);
    expect(screen.getByRole('radiogroup', { name: 'Velocity audience' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Retro pulse audience' })).toBeInTheDocument();
  });

  it('sets the audience when an unlocked rung is clicked', async () => {
    const user = userEvent.setup();
    // throughput ceiling is program_shared, so its SM rung is unlocked.
    policyHolder.data = policy();
    renderWithRouter(<ProjectSignalPrivacyPage />);
    const group = screen.getByRole('radiogroup', { name: 'Throughput rollup audience' });
    await user.click(within(group).getByRole('radio', { name: /SM/ }));
    expect(setAudienceMutate).toHaveBeenCalledWith({ signal: 'throughput_rollup', audience: 'team_sm' });
  });

  it('opens the team-decision dialog for a raise, then confirms', async () => {
    const user = userEvent.setup();
    renderWithRouter(<ProjectSignalPrivacyPage />);
    // Velocity ceiling is team → "Raise ceiling…" is offered.
    const velocityRow = screen.getByRole('radiogroup', { name: 'Velocity audience' }).closest('li')!;
    await user.click(within(velocityRow).getByRole('button', { name: /Raise ceiling/ }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
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
    policyHolder.data = policy({ can_set_audience: false, can_raise_ceiling: false, requester_tier: 'team' });
    renderWithRouter(<ProjectSignalPrivacyPage />);
    expect(screen.getByText(/Only the Scrum Master can change signal privacy/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Make everything team-only' })).not.toBeInTheDocument();
  });
});
