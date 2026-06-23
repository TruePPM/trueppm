import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { PokerSession } from '@/types';
import { EstimationPokerCard } from './EstimationPokerCard';

const useSprintPokerMock = vi.hoisted(() => vi.fn());
const openMock = vi.hoisted(() => vi.fn());
const voteMock = vi.hoisted(() => vi.fn());
const revealMock = vi.hoisted(() => vi.fn());
const reopenMock = vi.hoisted(() => vi.fn());
const commitMock = vi.hoisted(() => vi.fn());
const cancelMock = vi.hoisted(() => vi.fn());

vi.mock('./usePoker', () => ({
  useSprintPoker: useSprintPokerMock,
  useOpenPoker: () => ({ mutate: openMock, isPending: false }),
  useCastVote: () => ({ mutate: voteMock, isPending: false }),
  useRevealPoker: () => ({ mutate: revealMock, isPending: false }),
  useReopenPoker: () => ({ mutate: reopenMock, isPending: false }),
  useCommitPoker: () => ({ mutate: commitMock, isPending: false }),
  useCancelPoker: () => ({ mutate: cancelMock, isPending: false }),
}));

function session(overrides: Partial<PokerSession> = {}): PokerSession {
  return {
    id: 's1',
    task: { id: 't1', name: 'Login redesign' },
    state: 'open',
    committed_points: null,
    started_by: null,
    started_at: '2026-02-01T00:00:00Z',
    my_vote: null,
    vote_count: 0,
    participant_count: 5,
    votes: [],
    ...overrides,
  };
}

const CANDIDATES = [
  { id: 't1', name: 'Login redesign', story_points: null },
  { id: 't2', name: 'Estimated thing', story_points: 5 },
];

beforeEach(() => {
  vi.clearAllMocks();
  useSprintPokerMock.mockReturnValue({ sessions: [], isLoading: false, error: null });
});

describe('EstimationPokerCard', () => {
  it('renders nothing when no unestimated candidates and no live round', () => {
    const { container } = render(
      <EstimationPokerCard
        sprintId="sp1"
        candidates={[{ id: 't2', name: 'Done', story_points: 5 }]}
        canFacilitate
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('idle: facilitator gets a Start poker button for the next unestimated task', () => {
    render(<EstimationPokerCard sprintId="sp1" candidates={CANDIDATES} canFacilitate />);
    const btn = screen.getByRole('button', { name: /Start poker · Login redesign/ });
    fireEvent.click(btn);
    expect(openMock).toHaveBeenCalledWith({ sprintId: 'sp1', taskId: 't1' });
  });

  it('idle: a non-facilitator sees the count but no Start button', () => {
    render(<EstimationPokerCard sprintId="sp1" candidates={CANDIDATES} canFacilitate={false} />);
    expect(screen.getByText(/1 candidate still unestimated/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Start poker/ })).toBeNull();
  });

  it('open: shows the card row + tally and lets a member vote', () => {
    useSprintPokerMock.mockReturnValue({ sessions: [session({ vote_count: 2 })], isLoading: false, error: null });
    render(<EstimationPokerCard sprintId="sp1" candidates={CANDIDATES} canFacilitate={false} />);
    expect(screen.getByText('2 of 5 voted')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: '8 points' }));
    expect(voteMock).toHaveBeenCalledWith({ sprintId: 'sp1', sessionId: 's1', value: 8 });
  });

  it('open: a facilitator can reveal once a vote exists', () => {
    useSprintPokerMock.mockReturnValue({ sessions: [session({ vote_count: 1 })], isLoading: false, error: null });
    render(<EstimationPokerCard sprintId="sp1" candidates={CANDIDATES} canFacilitate />);
    fireEvent.click(screen.getByRole('button', { name: 'Reveal' }));
    expect(revealMock).toHaveBeenCalledWith({ sprintId: 'sp1', sessionId: 's1' });
  });

  it('open: a non-facilitator sees no Reveal/Cancel controls', () => {
    useSprintPokerMock.mockReturnValue({ sessions: [session({ vote_count: 1 })], isLoading: false, error: null });
    render(<EstimationPokerCard sprintId="sp1" candidates={CANDIDATES} canFacilitate={false} />);
    expect(screen.queryByRole('button', { name: 'Reveal' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it('revealed: shows votes, the outlier line, and commits the consensus default', () => {
    const revealed = session({
      state: 'revealed',
      votes: [
        { voter: { id: 'u1', username: 'a', display_name: 'Alice' }, value: 3, comment: '' },
        { voter: { id: 'u2', username: 'b', display_name: 'Bob' }, value: 3, comment: '' },
        { voter: { id: 'u3', username: 'c', display_name: 'Cara' }, value: 13, comment: 'infra' },
      ],
    });
    useSprintPokerMock.mockReturnValue({ sessions: [revealed], isLoading: false, error: null });
    render(<EstimationPokerCard sprintId="sp1" candidates={CANDIDATES} canFacilitate />);
    // Outlier surfaced (spread 3..13 → outlier at 13).
    expect(screen.getByText(/Outlier at 13/)).toBeTruthy();
    // Consensus default is the mode (3) → the commit pill offers 3.
    const commitBtn = screen.getByRole('button', { name: /Commit · 3 points/ });
    fireEvent.click(commitBtn);
    expect(commitMock).toHaveBeenCalledWith(
      { sprintId: 'sp1', sessionId: 's1', points: 3 },
      expect.anything(),
    );
  });

  it('revealed: a non-facilitator sees the votes but no commit control', () => {
    const revealed = session({
      state: 'revealed',
      votes: [{ voter: { id: 'u1', username: 'a', display_name: 'Alice' }, value: 5, comment: '' }],
    });
    useSprintPokerMock.mockReturnValue({ sessions: [revealed], isLoading: false, error: null });
    render(<EstimationPokerCard sprintId="sp1" candidates={CANDIDATES} canFacilitate={false} />);
    expect(screen.getByText(/Waiting for the facilitator/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Commit/ })).toBeNull();
  });
});
