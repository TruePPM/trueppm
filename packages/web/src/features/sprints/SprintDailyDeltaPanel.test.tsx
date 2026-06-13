import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SprintDailyDeltaPanel } from './SprintDailyDeltaPanel';
import type { SprintDailyDelta } from '@/hooks/useSprints';

interface QueryShape {
  data: SprintDailyDelta | undefined;
  isLoading: boolean;
  isError?: boolean;
  error?: unknown;
  refetch?: () => void;
  dataUpdatedAt?: number;
}

// The hook is called with (sprintId, { since }); capture the options so window-control
// switching can be asserted against the `since` the panel computes.
const useDeltaMock = vi.fn<() => QueryShape>();
let lastSince: string | undefined;
vi.mock('@/hooks/useSprints', () => ({
  useSprintDailyDelta: (_sprintId: string, opts?: { since?: string }) => {
    lastSince = opts?.since;
    return useDeltaMock();
  },
}));

// The task-drawer open mechanism (#1124) — the shared schedule store selectedTaskId.
const setSelectedTaskIdMock = vi.fn<(id: string | null) => void>();
vi.mock('@/stores/scheduleStore', () => ({
  useScheduleStore: (selector: (s: { setSelectedTaskId: (id: string | null) => void }) => unknown) =>
    selector({ setSelectedTaskId: setSelectedTaskIdMock }),
}));

// The reused scope-audit drawer (#1123) — render a marker so we can assert it opened.
vi.mock('./ScopeChangeDrawer', () => ({
  ScopeChangeDrawer: ({ sprintId }: { sprintId: string }) => (
    <div data-testid="scope-audit-drawer">{sprintId}</div>
  ),
}));

function delta(overrides: Partial<SprintDailyDelta> = {}): SprintDailyDelta {
  return {
    sprint_id: 's1',
    since: '2026-04-14T18:00:00Z',
    until: '2026-04-15T09:00:00Z',
    task_changes: [],
    scope_added: [],
    new_blockers: [],
    blocker_summary: { impediment: 0, paused: 0 },
    burndown_delta: null,
    per_actor: [],
    actor_aggregate: { moved: 0, completed: 0, added: 0, blocked: 0 },
    sprint_load: {
      committed_points: null,
      current_points: null,
      delta_points: null,
      pct_loaded: null,
    },
    ...overrides,
  };
}

function ok(data: SprintDailyDelta, extra: Partial<QueryShape> = {}): QueryShape {
  return {
    data,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
    dataUpdatedAt: Date.parse('2026-04-15T09:00:00Z'),
    ...extra,
  };
}

beforeEach(() => {
  useDeltaMock.mockReset();
  setSelectedTaskIdMock.mockReset();
  lastSince = undefined;
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
});

describe('SprintDailyDeltaPanel (#925)', () => {
  it('shows the empty state and a last-updated line when nothing changed', () => {
    useDeltaMock.mockReturnValue(ok(delta()));
    render(<SprintDailyDeltaPanel sprintId="s1" />);
    expect(screen.getByText(/Nothing changed in this window/i)).toBeInTheDocument();
    expect(screen.getByText(/Last updated/i)).toBeInTheDocument();
  });

  it('renders moved cards, blockers, scope, burndown, and the per-actor aggregate', () => {
    useDeltaMock.mockReturnValue(
      ok(
        delta({
          task_changes: [
            {
              task_id: 't1', task_short_id: 'T-1', task_title: 'Login flow', kind: 'status',
              from: 'IN_PROGRESS', to: 'REVIEW', actor_id: 4, actor_username: 'alex',
              at: '2026-04-15T08:00:00Z',
            },
          ],
          new_blockers: [
            {
              task_id: 't2', task_short_id: 'T-2', task_title: 'Payments', actor_username: 'alex',
              at: '2026-04-15T08:30:00Z', blocker_type: 'vendor', blocked_age_seconds: 3600,
              kind: 'impediment',
            },
          ],
          blocker_summary: { impediment: 1, paused: 0 },
          scope_added: [
            {
              task_id: 't3', task_short_id: 'T-3', task_title: 'Hotfix', added_by_username: 'jordan',
              at: '2026-04-15T07:00:00Z', status: 'PENDING', story_points: 3,
              epic: { id: 'e1', name: 'Checkout' },
            },
          ],
          burndown_delta: {
            prior_date: '2026-04-14', prior_remaining: 20, current_date: '2026-04-15',
            current_remaining: 12, remaining_delta: -8, completed_delta: 8,
          },
          per_actor: [{ actor_id: 4, actor_username: 'alex', moved: 1, completed: 0, added: 0, blocked: 1 }],
          actor_aggregate: { moved: 1, completed: 0, added: 1, blocked: 1 },
        }),
      ),
    );
    render(<SprintDailyDeltaPanel sprintId="s1" />);

    expect(screen.getByText(/Moved cards \(1\)/i)).toBeInTheDocument();
    expect(screen.getByText(/Login flow/)).toBeInTheDocument();
    expect(screen.getByText(/In progress → Review/i)).toBeInTheDocument();
    expect(screen.getByText(/New blockers \(1 impediment\)/i)).toBeInTheDocument();
    expect(screen.getByText(/Payments/)).toBeInTheDocument();
    // The structured type chip + age render; the free-text reason is never present.
    expect(screen.getByText('External vendor')).toBeInTheDocument();
    expect(screen.getByText('1h blocked')).toBeInTheDocument();
    expect(screen.getByText(/Scope added \(1\)/i)).toBeInTheDocument();
    expect(screen.getByText(/-8 pts remaining/i)).toBeInTheDocument();
    // Anti-scoreboard framing + team aggregate + per-actor block (#1126).
    expect(screen.getByText(/not to compare contributors/i)).toBeInTheDocument();
    expect(screen.getByText('Team')).toBeInTheDocument();
    expect(screen.getByText('alex')).toBeInTheDocument();
    // Scope point cost + epic tag (#1127).
    expect(screen.getByText('+3 pts')).toBeInTheDocument();
    expect(screen.getByText('Checkout')).toBeInTheDocument();
  });

  it('renders only the aggregate for a Viewer (empty per_actor from server) — #1126', () => {
    useDeltaMock.mockReturnValue(
      ok(
        delta({
          per_actor: [],
          actor_aggregate: { moved: 3, completed: 1, added: 0, blocked: 0 },
          task_changes: [
            {
              task_id: 't1', task_short_id: 'T-1', task_title: 'Login flow', kind: 'status',
              from: 'IN_PROGRESS', to: 'REVIEW', actor_id: null, actor_username: null,
              at: '2026-04-15T08:00:00Z',
            },
          ],
        }),
      ),
    );
    render(<SprintDailyDeltaPanel sprintId="s1" />);
    expect(screen.getByText('Team')).toBeInTheDocument();
    // No per-person rows — there is exactly one "moved" descriptor (the team line).
    expect(screen.getByText(/3 moved · 1 done/i)).toBeInTheDocument();
    expect(screen.queryByText('alex')).not.toBeInTheDocument();
  });

  it('shows the sprint-load indicator when points are readable, hides it when gated (#1127)', () => {
    useDeltaMock.mockReturnValue(
      ok(
        delta({
          task_changes: [
            { task_id: 't1', task_short_id: 'T-1', task_title: 'X', kind: 'status', from: 'NOT_STARTED', to: 'IN_PROGRESS', actor_id: 1, actor_username: 'a', at: '2026-04-15T08:00:00Z' },
          ],
          sprint_load: { committed_points: 20, current_points: 23, delta_points: 3, pct_loaded: 1.15 },
        }),
      ),
    );
    const { rerender } = render(<SprintDailyDeltaPanel sprintId="s1" />);
    expect(screen.getByText(/Sprint load/i)).toBeInTheDocument();
    expect(screen.getByText(/now 115% loaded/i)).toBeInTheDocument();

    // Gated: all point figures null → the row disappears, never "null".
    useDeltaMock.mockReturnValue(
      ok(
        delta({
          task_changes: [
            { task_id: 't1', task_short_id: 'T-1', task_title: 'X', kind: 'status', from: 'NOT_STARTED', to: 'IN_PROGRESS', actor_id: 1, actor_username: 'a', at: '2026-04-15T08:00:00Z' },
          ],
        }),
      ),
    );
    rerender(<SprintDailyDeltaPanel sprintId="s1" />);
    expect(screen.queryByText(/Sprint load/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/null/i)).not.toBeInTheDocument();
  });

  it('opens the in-context task drawer when a scope/moved row is clicked (#1124)', () => {
    useDeltaMock.mockReturnValue(
      ok(
        delta({
          scope_added: [
            { task_id: 't3', task_short_id: 'T-3', task_title: 'Hotfix', added_by_username: 'jordan', at: '2026-04-15T07:00:00Z', status: 'PENDING', story_points: null, epic: null },
          ],
        }),
      ),
    );
    render(<SprintDailyDeltaPanel sprintId="s1" />);
    fireEvent.click(screen.getByText('Hotfix'));
    expect(setSelectedTaskIdMock).toHaveBeenCalledWith('t3');
  });

  it('keeps a null-task-id scope row inert (#1124)', () => {
    useDeltaMock.mockReturnValue(
      ok(
        delta({
          scope_added: [
            { task_id: null, task_short_id: 'T-9', task_title: 'Ghost', added_by_username: 'jordan', at: '2026-04-15T07:00:00Z', status: 'PENDING', story_points: null, epic: null },
          ],
        }),
      ),
    );
    render(<SprintDailyDeltaPanel sprintId="s1" />);
    fireEvent.click(screen.getByText('Ghost'));
    expect(setSelectedTaskIdMock).not.toHaveBeenCalled();
  });

  it('opens the reused scope-audit drawer from the section header (#1123)', () => {
    useDeltaMock.mockReturnValue(
      ok(
        delta({
          scope_added: [
            { task_id: 't3', task_short_id: 'T-3', task_title: 'Hotfix', added_by_username: 'jordan', at: '2026-04-15T07:00:00Z', status: 'PENDING', story_points: null, epic: null },
          ],
        }),
      ),
    );
    render(<SprintDailyDeltaPanel sprintId="s1" />);
    expect(screen.queryByTestId('scope-audit-drawer')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /View scope audit/i }));
    expect(screen.getByTestId('scope-audit-drawer')).toBeInTheDocument();
  });

  it('switches the window control and passes a different since (#1123)', () => {
    useDeltaMock.mockReturnValue(ok(delta()));
    render(<SprintDailyDeltaPanel sprintId="s1" />);
    // Default is 24h.
    const since24 = lastSince;
    expect(since24).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '48h' }));
    expect(lastSince).toBeTruthy();
    expect(lastSince).not.toEqual(since24);
  });

  it('shows an error state with a Retry button (#1128)', () => {
    const refetch = vi.fn();
    useDeltaMock.mockReturnValue({ data: undefined, isLoading: false, isError: true, error: new Error('boom'), refetch });
    render(<SprintDailyDeltaPanel sprintId="s1" />);
    expect(screen.getByText(/Couldn't load the delta/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Retry/i }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('renders a loading skeleton', () => {
    useDeltaMock.mockReturnValue({ data: undefined, isLoading: true });
    const { container } = render(<SprintDailyDeltaPanel sprintId="s1" />);
    expect(container.querySelector('.animate-pulse')).toBeTruthy();
  });
});
