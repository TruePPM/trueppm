/**
 * WorkshopBanner unit tests — elapsed timer formatting, participant rendering,
 * end-button states. The elapsed string is driven by Date.now() and updates on
 * a 1s interval; tests pin time with vi.useFakeTimers() so assertions are
 * deterministic across H/M/S boundaries.
 */
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { WorkshopBanner } from './WorkshopBanner';
import type { WorkshopSession, WorkshopParticipant } from '@/types';

function makeParticipant(overrides: Partial<WorkshopParticipant> = {}): WorkshopParticipant {
  return {
    id: 1,
    user_id: 'user-1',
    display_name: 'Alice',
    joined_at: '2026-04-29T10:00:00Z',
    left_at: null,
    color_index: 0,
    ...overrides,
  };
}

function makeSession(overrides: Partial<WorkshopSession> = {}): WorkshopSession {
  return {
    id: 'session-uuid',
    project_id: 'project-uuid',
    started_by_id: 'user-1',
    started_at: '2026-04-29T10:00:00Z',
    ended_at: null,
    participants: [],
    ...overrides,
  };
}

describe('WorkshopBanner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Pin "now" 65 seconds after session start so the initial elapsed render
    // is 1:05 — covers the m:ss code path in formatElapsed.
    vi.setSystemTime(new Date('2026-04-29T10:01:05Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the workshop label and elapsed timer in m:ss format', () => {
    const session = makeSession();
    render(<WorkshopBanner session={session} onEnd={vi.fn()} />);

    expect(screen.getByText('Workshop mode')).toBeInTheDocument();
    expect(screen.getByLabelText('Session elapsed time: 1:05')).toBeInTheDocument();
  });

  it('formats elapsed in H:MM:SS once the session passes one hour', () => {
    // 1h 2m 3s after start = 3723s
    vi.setSystemTime(new Date('2026-04-29T11:02:03Z'));
    const session = makeSession();
    render(<WorkshopBanner session={session} onEnd={vi.fn()} />);

    expect(screen.getByLabelText('Session elapsed time: 1:02:03')).toBeInTheDocument();
  });

  it('clamps negative elapsed (clock skew) to 0:00', () => {
    // System time before started_at — defends against client clock skew.
    vi.setSystemTime(new Date('2026-04-29T09:59:00Z'));
    const session = makeSession();
    render(<WorkshopBanner session={session} onEnd={vi.fn()} />);

    expect(screen.getByLabelText('Session elapsed time: 0:00')).toBeInTheDocument();
  });

  it('updates the elapsed timer every second', () => {
    const session = makeSession();
    render(<WorkshopBanner session={session} onEnd={vi.fn()} />);

    expect(screen.getByLabelText('Session elapsed time: 1:05')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(screen.getByLabelText('Session elapsed time: 1:07')).toBeInTheDocument();
  });

  it('omits the participant count when no one is online', () => {
    const session = makeSession({ participants: [] });
    render(<WorkshopBanner session={session} onEnd={vi.fn()} />);

    expect(screen.queryByText(/online$/)).not.toBeInTheDocument();
  });

  it('renders only active participants (left_at === null)', () => {
    const session = makeSession({
      participants: [
        makeParticipant({ id: 1, display_name: 'Alice', color_index: 0 }),
        makeParticipant({
          id: 2,
          display_name: 'Bob',
          color_index: 1,
          left_at: '2026-04-29T10:00:30Z',
        }),
      ],
    });
    render(<WorkshopBanner session={session} onEnd={vi.fn()} />);

    expect(screen.getByLabelText('1 participant online')).toBeInTheDocument();
  });

  it('uses the plural label when multiple participants are online', () => {
    const session = makeSession({
      participants: [
        makeParticipant({ id: 1, display_name: 'Alice', color_index: 0 }),
        makeParticipant({ id: 2, display_name: 'Bob', color_index: 1 }),
      ],
    });
    render(<WorkshopBanner session={session} onEnd={vi.fn()} />);

    expect(screen.getByLabelText('2 participants online')).toBeInTheDocument();
  });

  it('shows up to 5 avatar initials and a +N overflow badge', () => {
    const session = makeSession({
      participants: Array.from({ length: 7 }, (_, i) =>
        makeParticipant({
          id: i + 1,
          user_id: `user-${i + 1}`,
          display_name: `User ${String.fromCharCode(65 + i)}`,
          color_index: i,
        }),
      ),
    });
    render(<WorkshopBanner session={session} onEnd={vi.fn()} />);

    // First five initials are rendered (User A..User E).
    expect(screen.getByTitle('User A')).toHaveTextContent('U');
    expect(screen.getByTitle('User E')).toBeInTheDocument();
    // Sixth and seventh collapse into a +2 badge.
    expect(screen.getByText('+2')).toBeInTheDocument();
    // The seventh participant has no individual avatar.
    expect(screen.queryByTitle('User G')).not.toBeInTheDocument();
  });

  it('invokes onEnd when the End Workshop button is clicked', () => {
    const onEnd = vi.fn();
    const session = makeSession();
    render(<WorkshopBanner session={session} onEnd={onEnd} />);

    fireEvent.click(screen.getByRole('button', { name: 'End workshop session' }));
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('disables the End Workshop button and shows "Ending…" while ending', () => {
    const session = makeSession();
    render(<WorkshopBanner session={session} onEnd={vi.fn()} isEnding />);

    const button = screen.getByRole('button', { name: 'End workshop session' });
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent('Ending…');
  });
});
