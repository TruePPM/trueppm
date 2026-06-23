import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, within } from '@testing-library/react';
import { renderWithProviders as render } from '@/test/utils';
import { MemoryRouter } from 'react-router';
import { StandupMode } from './StandupMode';
import type { StandupBucket, StandupResponse } from './useStandup';

interface QueryShape {
  data: StandupResponse | undefined;
  isLoading: boolean;
  isError: boolean;
}

const useStandupMock = vi.fn<() => QueryShape>();
vi.mock('./useStandup', () => ({
  useStandup: () => useStandupMock(),
}));

function bucket(name: string | null, overrides: Partial<StandupBucket> = {}): StandupBucket {
  return {
    assignee: name === null ? null : { id: name, name },
    done: [],
    in_progress: [],
    blockers: [],
    ...overrides,
  };
}

function active(walk: StandupBucket[]): StandupResponse {
  return {
    active: true,
    reason: null,
    sprint: {
      id: 's1',
      name: 'Sprint 1',
      goal: 'Ship the checkout redesign',
      start_date: '2026-06-01',
      finish_date: '2026-06-14',
    },
    generated_at: '2026-06-08T09:00:00Z',
    window_since: '2026-06-05T00:00:00Z',
    walk,
  };
}

function renderMode(onOpenTask = vi.fn(), onClose = vi.fn()) {
  return render(
    <MemoryRouter>
      <StandupMode projectId="p1" onClose={onClose} onOpenTask={onOpenTask} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useStandupMock.mockReset();
});

describe('StandupMode', () => {
  it('pins the sprint goal and shows the first teammate', () => {
    useStandupMock.mockReturnValue({
      data: active([bucket('Bea'), bucket('Dev')]),
      isLoading: false,
      isError: false,
    });
    renderMode();
    expect(screen.getByText('Ship the checkout redesign')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Bea' })).toBeInTheDocument();
    expect(screen.getByText('1 of', { exact: false })).toBeInTheDocument();
  });

  it('walks person-to-person with the stepper, clamping at both ends', () => {
    useStandupMock.mockReturnValue({
      data: active([bucket('Bea'), bucket('Dev')]),
      isLoading: false,
      isError: false,
    });
    renderMode();
    const prev = screen.getByRole('button', { name: 'Previous teammate' });
    const next = screen.getByRole('button', { name: 'Next teammate' });
    expect(prev).toBeDisabled(); // clamped at person 1

    fireEvent.click(next);
    expect(screen.getByRole('heading', { name: 'Dev' })).toBeInTheDocument();
    expect(next).toBeDisabled(); // clamped at the last person
    expect(prev).not.toBeDisabled();
  });

  it('walks with the arrow keys and exits on Escape', () => {
    const onClose = vi.fn();
    useStandupMock.mockReturnValue({
      data: active([bucket('Bea'), bucket('Dev')]),
      isLoading: false,
      isError: false,
    });
    renderMode(vi.fn(), onClose);
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(screen.getByRole('heading', { name: 'Dev' })).toBeInTheDocument();
    // Esc is handled by useFocusTrap, which listens on document.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('jumps directly to a teammate via the person rail', () => {
    useStandupMock.mockReturnValue({
      data: active([bucket('Bea'), bucket('Dev'), bucket('Cara')]),
      isLoading: false,
      isError: false,
    });
    renderMode();
    fireEvent.click(screen.getByRole('button', { name: 'Go to Cara' }));
    expect(screen.getByRole('heading', { name: 'Cara' })).toBeInTheDocument();
  });

  it('shows a done card with a check and an in-progress card, and opens a task on click', () => {
    const onOpenTask = vi.fn();
    useStandupMock.mockReturnValue({
      data: active([
        bucket('Bea', {
          done: [
            {
              id: 't1',
              name: 'Coupon field',
              status: 'COMPLETE',
              story_points: 3,
              dwell_days: 0,
              aging: false,
              blocker_type: null,
              blocked_since: null,
            },
          ],
          in_progress: [
            {
              id: 't2',
              name: 'Vault card',
              status: 'IN_PROGRESS',
              story_points: 5,
              dwell_days: 1,
              aging: false,
              blocker_type: null,
              blocked_since: null,
            },
          ],
        }),
      ]),
      isLoading: false,
      isError: false,
    });
    renderMode(onOpenTask);
    expect(screen.getByText('Coupon field')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Vault card'));
    expect(onOpenTask).toHaveBeenCalledWith('t2');
  });

  it('renders a blocker by type + age and never leaks the private reason', () => {
    useStandupMock.mockReturnValue({
      data: active([
        bucket('Bea', {
          blockers: [
            {
              id: 't3',
              name: 'Tax service',
              status: 'IN_PROGRESS',
              story_points: 2,
              dwell_days: 2,
              aging: false,
              blocker_type: 'vendor',
              blocked_since: '2026-06-06T09:00:00Z',
            },
          ],
        }),
      ]),
      isLoading: false,
      isError: false,
    });
    renderMode();
    // Routable type chip is shown; there is no reason field on the wire at all.
    expect(screen.getByText('External vendor')).toBeInTheDocument();
    expect(screen.queryByText(/reason/i)).not.toBeInTheDocument();
  });

  it('flags an aging in-progress card with a calm "stale Nd" pill', () => {
    useStandupMock.mockReturnValue({
      data: active([
        bucket('Bea', {
          in_progress: [
            {
              id: 't4',
              name: 'Stuck card',
              status: 'IN_PROGRESS',
              story_points: null,
              dwell_days: 6,
              aging: true,
              blocker_type: null,
              blocked_since: null,
            },
          ],
        }),
      ]),
      isLoading: false,
      isError: false,
    });
    renderMode();
    expect(screen.getByText('stale 6d')).toBeInTheDocument();
  });

  it('shows an honest empty state when there is no active sprint', () => {
    useStandupMock.mockReturnValue({
      data: {
        active: false,
        reason: 'no_active_sprint',
        sprint: null,
        generated_at: '2026-06-08T09:00:00Z',
        window_since: null,
        walk: [],
      },
      isLoading: false,
      isError: false,
    });
    renderMode();
    expect(screen.getByText('No active sprint to walk')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to sprints →' })).toBeInTheDocument();
  });

  it('explains continuous cadence has no standup walk', () => {
    useStandupMock.mockReturnValue({
      data: {
        active: false,
        reason: 'continuous_cadence',
        sprint: null,
        generated_at: '2026-06-08T09:00:00Z',
        window_since: null,
        walk: [],
      },
      isLoading: false,
      isError: false,
    });
    renderMode();
    expect(screen.getByText('This board runs in continuous flow')).toBeInTheDocument();
  });

  it('places the Unassigned bucket last and labels it', () => {
    useStandupMock.mockReturnValue({
      data: active([bucket('Bea'), bucket(null, { in_progress: [] })]),
      isLoading: false,
      isError: false,
    });
    renderMode();
    fireEvent.click(screen.getByRole('button', { name: 'Next teammate' }));
    expect(screen.getByRole('heading', { name: 'Unassigned' })).toBeInTheDocument();
  });

  it('announces the walk position to assistive tech (name comes from heading focus)', () => {
    useStandupMock.mockReturnValue({
      data: active([bucket('Bea'), bucket('Dev')]),
      isLoading: false,
      isError: false,
    });
    const { container } = renderMode();
    const live = container.querySelector('[role="status"][aria-live="polite"]');
    expect(live?.textContent).toBe('Person 1 of 2');
    fireEvent.click(screen.getByRole('button', { name: 'Next teammate' }));
    expect(within(container).getByText('Person 2 of 2')).toBeInTheDocument();
    // The teammate name is the focused heading, not duplicated in the live region.
    expect(screen.getByRole('heading', { name: 'Dev' })).toBeInTheDocument();
  });
});
