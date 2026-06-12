import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SprintDailyDeltaPanel } from './SprintDailyDeltaPanel';
import type { SprintDailyDelta } from '@/hooks/useSprints';

const useDeltaMock = vi.fn<() => { data: SprintDailyDelta | undefined; isLoading: boolean }>();
vi.mock('@/hooks/useSprints', () => ({
  useSprintDailyDelta: () => useDeltaMock(),
}));

function delta(overrides: Partial<SprintDailyDelta> = {}): SprintDailyDelta {
  return {
    sprint_id: 's1',
    since: '2026-04-14T18:00:00Z',
    until: '2026-04-15T09:00:00Z',
    task_changes: [],
    scope_added: [],
    new_blockers: [],
    burndown_delta: null,
    per_actor: [],
    ...overrides,
  };
}

beforeEach(() => useDeltaMock.mockReset());

describe('SprintDailyDeltaPanel (#925)', () => {
  it('shows the empty state when nothing changed', () => {
    useDeltaMock.mockReturnValue({ data: delta(), isLoading: false });
    render(<SprintDailyDeltaPanel sprintId="s1" />);
    expect(screen.getByText(/Nothing changed since yesterday/i)).toBeInTheDocument();
  });

  it('renders moved cards, new blockers, scope, burndown, and the per-actor at-a-glance', () => {
    useDeltaMock.mockReturnValue({
      data: delta({
        task_changes: [
          {
            task_id: 't1', task_short_id: 'T-1', task_title: 'Login flow', kind: 'status',
            from: 'IN_PROGRESS', to: 'REVIEW', actor_id: 4, actor_username: 'alex',
            at: '2026-04-15T08:00:00Z',
          },
        ],
        new_blockers: [
          { task_id: 't2', task_short_id: 'T-2', task_title: 'Payments', actor_username: 'alex', at: '2026-04-15T08:30:00Z' },
        ],
        scope_added: [
          { task_id: 't3', task_short_id: 'T-3', task_title: 'Hotfix', added_by_username: 'jordan', at: '2026-04-15T07:00:00Z', status: 'PENDING' },
        ],
        burndown_delta: {
          prior_date: '2026-04-14', prior_remaining: 20, current_date: '2026-04-15',
          current_remaining: 12, remaining_delta: -8, completed_delta: 8,
        },
        per_actor: [
          { actor_id: 4, actor_username: 'alex', moved: 1, completed: 0, added: 0, blocked: 1 },
        ],
      }),
      isLoading: false,
    });
    render(<SprintDailyDeltaPanel sprintId="s1" />);

    expect(screen.getByText(/Moved cards \(1\)/i)).toBeInTheDocument();
    expect(screen.getByText(/Login flow/)).toBeInTheDocument();
    expect(screen.getByText(/In progress → Review/i)).toBeInTheDocument();
    expect(screen.getByText(/New blockers \(1\)/i)).toBeInTheDocument();
    expect(screen.getByText(/Payments/)).toBeInTheDocument();
    expect(screen.getByText(/Scope added \(1\)/i)).toBeInTheDocument();
    expect(screen.getByText(/-8 pts remaining/i)).toBeInTheDocument();
    // Per-actor at-a-glance: counts only, never durations.
    expect(screen.getByText('alex')).toBeInTheDocument();
    expect(screen.getByText(/1 moved · 1 blocked/i)).toBeInTheDocument();
  });

  it('renders a loading skeleton', () => {
    useDeltaMock.mockReturnValue({ data: undefined, isLoading: true });
    const { container } = render(<SprintDailyDeltaPanel sprintId="s1" />);
    expect(container.querySelector('.animate-pulse')).toBeTruthy();
  });
});
