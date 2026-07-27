import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders as render } from '@/test/utils';
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
// The burndown hook supplies the sprint finish date for the sub-5-day footnote (#1238).
// Default: no finish date → no footnote, so the existing tests are unaffected.
const useBurndownMock = vi.fn<() => { data: { sprint: { finish_date: string } } | undefined }>();
vi.mock('@/hooks/useSprints', () => ({
  useSprintDailyDelta: (_sprintId: string, opts?: { since?: string }) => {
    lastSince = opts?.since;
    return useDeltaMock();
  },
  useSprintBurndown: () => useBurndownMock(),
}));

// The task-drawer open mechanism (#1124) — the shared schedule store selectedTaskId.
const setSelectedTaskIdMock = vi.fn<(id: string | null) => void>();
vi.mock('@/stores/scheduleStore', () => ({
  useScheduleStore: (selector: (s: { setSelectedTaskId: (id: string | null) => void }) => unknown) =>
    selector({ setSelectedTaskId: setSelectedTaskIdMock }),
}));

// The reused scope-audit drawer (#1123) — render a marker so we can assert it opened.
vi.mock('./ScopeChangeDrawer', () => ({
  ScopeChangeDrawer: ({ sprintId, onClose }: { sprintId: string; onClose: () => void }) => (
    <div data-testid="scope-audit-drawer">
      {sprintId}
      <button type="button" onClick={onClose}>
        Close scope audit
      </button>
    </div>
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

/**
 * A deliberately malformed payload (a lenient mock/proxy returning a non-delta
 * body). The panel guards against this shape rather than crashing the page, so
 * the spec has to be able to express it.
 */
function malformed(body: Record<string, unknown>): SprintDailyDelta {
  return body as unknown as SprintDailyDelta;
}

/** A single moved card — the cheapest way to make the panel non-empty. */
const ONE_MOVE = {
  task_id: 't1',
  task_short_id: 'T-1',
  task_title: 'Login flow',
  kind: 'status' as const,
  from: 'IN_PROGRESS',
  to: 'REVIEW',
  actor_id: 4,
  actor_username: 'alex',
  at: '2026-04-15T08:00:00Z',
};

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
  // No finish date by default → the #1238 footnote never renders in unrelated tests.
  useBurndownMock.mockReset();
  useBurndownMock.mockReturnValue({ data: undefined });
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
    expect(container.querySelector('[class*="animate-pulse"]')).toBeTruthy();
  });

  describe('sub-5-day "N days left" burndown footnote (#1238)', () => {
    const burndownDelta = {
      prior_date: '2026-04-13', prior_remaining: 20, current_date: '2026-04-14',
      current_remaining: 12, remaining_delta: -8, completed_delta: 8,
    };

    afterEach(() => {
      vi.useRealTimers();
    });

    it('appends the footnote when fewer than 5 working days remain', () => {
      // Mon 2026-04-13 → finish Fri 2026-04-17 = 5 working days inclusive… use a
      // finish that leaves exactly 3 working days (Wed → Fri).
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-15T09:00:00Z')); // Wednesday
      useDeltaMock.mockReturnValue(ok(delta({ burndown_delta: burndownDelta })));
      useBurndownMock.mockReturnValue({ data: { sprint: { finish_date: '2026-04-17' } } });
      render(<SprintDailyDeltaPanel sprintId="s1" />);
      // Wed, Thu, Fri = 3 working days left.
      expect(screen.getByText('(3 days left)')).toBeInTheDocument();
    });

    it('uses the singular "day" at one working day left', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-17T09:00:00Z')); // Friday, finish same day
      useDeltaMock.mockReturnValue(ok(delta({ burndown_delta: burndownDelta })));
      useBurndownMock.mockReturnValue({ data: { sprint: { finish_date: '2026-04-17' } } });
      render(<SprintDailyDeltaPanel sprintId="s1" />);
      expect(screen.getByText('(1 day left)')).toBeInTheDocument();
    });

    it('omits the footnote when 5 or more working days remain', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-13T09:00:00Z')); // Monday
      useDeltaMock.mockReturnValue(ok(delta({ burndown_delta: burndownDelta })));
      // Finish two weeks out → well over a working week of runway.
      useBurndownMock.mockReturnValue({ data: { sprint: { finish_date: '2026-04-27' } } });
      render(<SprintDailyDeltaPanel sprintId="s1" />);
      expect(screen.queryByText(/days? left/)).not.toBeInTheDocument();
    });

    it('omits the footnote once the sprint finish date has passed', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-20T09:00:00Z'));
      useDeltaMock.mockReturnValue(ok(delta({ burndown_delta: burndownDelta })));
      useBurndownMock.mockReturnValue({ data: { sprint: { finish_date: '2026-04-17' } } });
      render(<SprintDailyDeltaPanel sprintId="s1" />);
      expect(screen.queryByText(/days? left/)).not.toBeInTheDocument();
    });

    it('omits the footnote when the finish date is unparseable', () => {
      useDeltaMock.mockReturnValue(ok(delta({ burndown_delta: burndownDelta })));
      useBurndownMock.mockReturnValue({ data: { sprint: { finish_date: 'not-a-date' } } });
      render(<SprintDailyDeltaPanel sprintId="s1" />);
      expect(screen.queryByText(/days? left/)).not.toBeInTheDocument();
      // The burndown row itself still renders — only the footnote is dropped.
      expect(screen.getByText(/-8 pts remaining/)).toBeInTheDocument();
    });
  });
});

describe('SprintDailyDeltaPanel — defensive payload guards', () => {
  it('renders nothing when the query settles with no data', () => {
    useDeltaMock.mockReturnValue({ data: undefined, isLoading: false, isError: false });
    render(<SprintDailyDeltaPanel sprintId="s1" />);
    expect(screen.queryByTestId('sprint-daily-delta')).not.toBeInTheDocument();
  });

  it('renders nothing when task_changes is not an array', () => {
    useDeltaMock.mockReturnValue(ok(malformed({ ...delta(), task_changes: null })));
    render(<SprintDailyDeltaPanel sprintId="s1" />);
    expect(screen.queryByTestId('sprint-daily-delta')).not.toBeInTheDocument();
  });

  it('skips the sprint-load row entirely when the payload omits it', () => {
    useDeltaMock.mockReturnValue(
      ok(malformed({ ...delta({ task_changes: [ONE_MOVE] }), sprint_load: null })),
    );
    render(<SprintDailyDeltaPanel sprintId="s1" />);
    expect(screen.getByTestId('sprint-daily-delta')).toBeInTheDocument();
    expect(screen.queryByText(/load$/i)).not.toBeInTheDocument();
  });

  it('drops the "since …" subtitle when the window timestamp is unparseable', () => {
    useDeltaMock.mockReturnValue(ok(delta({ since: 'garbage' })));
    render(<SprintDailyDeltaPanel sprintId="s1" />);
    const heading = screen.getByRole('heading', { name: 'Daily delta' });
    expect(heading.parentElement?.textContent).toBe('Daily delta');
    expect(screen.getByText(/Nothing changed in this window/i)).toBeInTheDocument();
  });

  it('shows the "since …" subtitle for a parseable window timestamp', () => {
    useDeltaMock.mockReturnValue(ok(delta()));
    render(<SprintDailyDeltaPanel sprintId="s1" />);
    const heading = screen.getByRole('heading', { name: 'Daily delta' });
    expect(heading.parentElement?.textContent).toMatch(/Daily deltasince /);
  });

  it('falls back to the fetch time when `until` is missing entirely (#1128)', () => {
    const dataUpdatedAt = Date.parse('2026-04-15T09:00:00Z');
    const body = { ...delta({ task_changes: [ONE_MOVE] }) } as Record<string, unknown>;
    delete body.until;
    useDeltaMock.mockReturnValue(ok(malformed(body), { dataUpdatedAt }));
    render(<SprintDailyDeltaPanel sprintId="s1" />);
    const expected = new Date(dataUpdatedAt).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });
    expect(screen.getByText(`Last updated ${expected}`)).toBeInTheDocument();
    // With no `until` there is nothing to mark as seen.
    expect(window.localStorage.getItem('trueppm:daily-delta:lastSeen:s1')).toBeNull();
  });

  it('falls back to the fetch time when `until` is unparseable (#1128)', () => {
    const dataUpdatedAt = Date.parse('2026-04-15T09:00:00Z');
    useDeltaMock.mockReturnValue(ok(delta({ until: 'nonsense' }), { dataUpdatedAt }));
    render(<SprintDailyDeltaPanel sprintId="s1" />);
    const expected = new Date(dataUpdatedAt).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });
    expect(screen.getByText(`Last updated ${expected}`)).toBeInTheDocument();
  });
});

describe('SprintDailyDeltaPanel — the "since I last looked" window (#1123)', () => {
  const KEY = 'trueppm:daily-delta:lastSeen:s1';

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('replays the stored gap when "Since I last looked" is chosen', () => {
    window.localStorage.setItem(KEY, '2026-04-10T17:00:00.000Z');
    useDeltaMock.mockReturnValue(ok(delta()));
    render(<SprintDailyDeltaPanel sprintId="s1" />);

    fireEvent.click(screen.getByRole('button', { name: /Since I last looked/i }));
    expect(lastSince).toEqual('2026-04-10T17:00:00.000Z');
  });

  it('falls back to a 24h window when nothing was ever stored', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-15T09:00:00Z'));
    useDeltaMock.mockReturnValue(ok(delta()));
    render(<SprintDailyDeltaPanel sprintId="s1" />);

    fireEvent.click(screen.getByRole('button', { name: /Since I last looked/i }));
    expect(lastSince).toEqual(new Date(Date.parse('2026-04-15T09:00:00Z') - 24 * 3_600_000).toISOString());
  });

  it('advances the stored timestamp once the delta has loaded', () => {
    useDeltaMock.mockReturnValue(ok(delta()));
    render(<SprintDailyDeltaPanel sprintId="s1" />);
    const stored = window.localStorage.getItem(KEY);
    expect(stored).toBeTruthy();
    expect(Number.isNaN(Date.parse(stored ?? ''))).toBe(false);
  });

  it('does not advance the stored timestamp while the read is failing', () => {
    useDeltaMock.mockReturnValue({ data: undefined, isLoading: false, isError: true, refetch: vi.fn() });
    render(<SprintDailyDeltaPanel sprintId="s1" />);
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it('degrades gracefully when localStorage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    useDeltaMock.mockReturnValue(ok(delta()));
    render(<SprintDailyDeltaPanel sprintId="s1" />);

    expect(screen.getByText(/Nothing changed in this window/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Since I last looked/i }));
    // No stored timestamp is readable, so the option still resolves to a window.
    expect(lastSince).toBeTruthy();
  });
});

describe('SprintDailyDeltaPanel — burndown row tones', () => {
  function burndown(remaining_delta: number, completed_delta: number) {
    return {
      prior_date: '2026-04-14',
      prior_remaining: 10,
      current_date: '2026-04-15',
      current_remaining: 10 + remaining_delta,
      remaining_delta,
      completed_delta,
    };
  }

  it('flags rising remaining work as at risk', () => {
    useDeltaMock.mockReturnValue(ok(delta({ burndown_delta: burndown(5, 0) })));
    render(<SprintDailyDeltaPanel sprintId="s1" />);
    const figure = screen.getByLabelText('Remaining work up 5 points — at risk');
    expect(figure).toHaveTextContent('+5 pts remaining');
    expect(figure.className).toContain('text-semantic-at-risk');
  });

  it('reads an unchanged burndown as neutral and hides the "done" segment', () => {
    useDeltaMock.mockReturnValue(ok(delta({ burndown_delta: burndown(0, 0) })));
    render(<SprintDailyDeltaPanel sprintId="s1" />);
    const figure = screen.getByLabelText('Remaining work unchanged');
    expect(figure).toHaveTextContent('0 pts remaining');
    expect(screen.getByText('(10 → 10)')).toBeInTheDocument();
    expect(screen.queryByText(/done\)/)).not.toBeInTheDocument();
  });

  it('reads falling remaining work as on track', () => {
    useDeltaMock.mockReturnValue(ok(delta({ burndown_delta: burndown(-4, 4) })));
    render(<SprintDailyDeltaPanel sprintId="s1" />);
    const figure = screen.getByLabelText('Remaining work down 4 points — on track');
    expect(figure.className).toContain('text-semantic-on-track');
    expect(screen.getByText('(10 → 6, +4 done)')).toBeInTheDocument();
  });
});

describe('SprintDailyDeltaPanel — sprint load row (#1127)', () => {
  function withLoad(load: SprintDailyDelta['sprint_load']) {
    useDeltaMock.mockReturnValue(ok(delta({ task_changes: [ONE_MOVE], sprint_load: load })));
    render(<SprintDailyDeltaPanel sprintId="s1" />);
  }

  it('renders an em dash for a missing committed figure and hides a zero delta', () => {
    withLoad({ committed_points: null, current_points: 12, delta_points: 0, pct_loaded: null });
    expect(screen.getByText('— → 12')).toBeInTheDocument();
    expect(screen.queryByText(/Δ/)).not.toBeInTheDocument();
    expect(screen.queryByText(/% loaded/)).not.toBeInTheDocument();
  });

  it('renders a negative delta and an under-capacity percentage', () => {
    withLoad({ committed_points: 20, current_points: 17, delta_points: -3, pct_loaded: 0.5 });
    expect(screen.getByText('(Δ -3)')).toBeInTheDocument();
    const pct = screen.getByText('now 50% loaded');
    expect(pct.className).not.toContain('text-semantic-at-risk');
  });

  it('renders an em dash for a missing current figure', () => {
    withLoad({ committed_points: 20, current_points: null, delta_points: null, pct_loaded: null });
    expect(screen.getByText('20 → —')).toBeInTheDocument();
  });
});

describe('SprintDailyDeltaPanel — per-actor framing (#1126)', () => {
  it('omits the team line when every aggregate count is zero', () => {
    useDeltaMock.mockReturnValue(
      ok(
        delta({
          task_changes: [ONE_MOVE],
          actor_aggregate: { moved: 0, completed: 0, added: 0, blocked: 0 },
          per_actor: [
            { actor_id: null, actor_username: null, moved: 0, completed: 0, added: 1, blocked: 0 },
          ],
        }),
      ),
    );
    render(<SprintDailyDeltaPanel sprintId="s1" />);
    expect(screen.queryByText('Team')).not.toBeInTheDocument();
    // A null actor is attributed to "Someone", never to a made-up username.
    expect(screen.getByText('Someone')).toBeInTheDocument();
    expect(screen.getByText('1 added')).toBeInTheDocument();
  });

  it('renders every count kind in the team summary', () => {
    useDeltaMock.mockReturnValue(
      ok(
        delta({
          task_changes: [ONE_MOVE],
          actor_aggregate: { moved: 1, completed: 2, added: 4, blocked: 3 },
        }),
      ),
    );
    render(<SprintDailyDeltaPanel sprintId="s1" />);
    expect(screen.getByText(/1 moved · 2 done · 3 blocked · 4 added/)).toBeInTheDocument();
  });
});

describe('SprintDailyDeltaPanel — blockers row (ADR-0124, #1125)', () => {
  const pausedBlocker = {
    task_id: 't5',
    task_short_id: 'T-5',
    task_title: 'Waiting card',
    actor_username: null,
    at: '2026-04-15T08:30:00Z',
    blocker_type: null,
    blocked_age_seconds: null,
    kind: 'paused' as const,
  };

  it('renders a paused-only headline with no age or attribution', () => {
    useDeltaMock.mockReturnValue(
      ok(
        delta({
          new_blockers: [pausedBlocker],
          blocker_summary: { impediment: 0, paused: 1 },
        }),
      ),
    );
    render(<SprintDailyDeltaPanel sprintId="s1" />);
    expect(screen.getByText(/New blockers \(1 paused\)/)).toBeInTheDocument();
    expect(screen.getByText('Paused')).toBeInTheDocument();
    expect(screen.queryByText(/blocked$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^by /)).not.toBeInTheDocument();
  });

  it('combines both counts in the headline when the split is mixed', () => {
    useDeltaMock.mockReturnValue(
      ok(
        delta({
          new_blockers: [
            pausedBlocker,
            {
              task_id: 't6',
              task_short_id: 'T-6',
              task_title: 'Stuck card',
              actor_username: 'sam',
              at: '2026-04-15T08:30:00Z',
              blocker_type: null,
              blocked_age_seconds: 90_000,
              kind: 'impediment' as const,
            },
          ],
          blocker_summary: { impediment: 1, paused: 1 },
        }),
      ),
    );
    render(<SprintDailyDeltaPanel sprintId="s1" />);
    expect(screen.getByText(/New blockers \(1 impediment, 1 paused\)/)).toBeInTheDocument();
    // No structured type recorded → the generic "Impediment" chip.
    expect(screen.getByText('Impediment')).toBeInTheDocument();
    expect(screen.getByText('1d 1h blocked')).toBeInTheDocument();
    expect(screen.getByText('by sam')).toBeInTheDocument();
  });
});

describe('SprintDailyDeltaPanel — row rendering edges', () => {
  it('falls back to the raw status code for an unmapped transition', () => {
    useDeltaMock.mockReturnValue(
      ok(
        delta({
          task_changes: [{ ...ONE_MOVE, from: 'WEIRD_STATE', to: 'COMPLETE' }],
        }),
      ),
    );
    render(<SprintDailyDeltaPanel sprintId="s1" />);
    expect(screen.getByText('WEIRD_STATE → Done')).toBeInTheDocument();
  });

  it('renders a bare scope row with no epic, points, or attribution', () => {
    useDeltaMock.mockReturnValue(
      ok(
        delta({
          scope_added: [
            {
              task_id: null,
              task_short_id: 'T-9',
              task_title: 'Ghost',
              added_by_username: null,
              at: '2026-04-15T07:00:00Z',
              status: 'PENDING',
              story_points: null,
              epic: null,
            },
          ],
        }),
      ),
    );
    render(<SprintDailyDeltaPanel sprintId="s1" />);
    expect(screen.getByText('Scope added (1)')).toBeInTheDocument();
    expect(screen.getByText('Ghost')).toBeInTheDocument();
    expect(screen.queryByText(/pts$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^by /)).not.toBeInTheDocument();
  });

  it('closes the scope-audit drawer again from its own dismiss (#1123)', () => {
    useDeltaMock.mockReturnValue(
      ok(
        delta({
          scope_added: [
            {
              task_id: 't3',
              task_short_id: 'T-3',
              task_title: 'Hotfix',
              added_by_username: 'jordan',
              at: '2026-04-15T07:00:00Z',
              status: 'PENDING',
              story_points: null,
              epic: null,
            },
          ],
        }),
      ),
    );
    render(<SprintDailyDeltaPanel sprintId="s1" />);
    fireEvent.click(screen.getByRole('button', { name: /View scope audit/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Close scope audit' }));
    expect(screen.queryByTestId('scope-audit-drawer')).not.toBeInTheDocument();
  });

  it('opens the task drawer from a moved row too (#1124)', () => {
    useDeltaMock.mockReturnValue(ok(delta({ task_changes: [ONE_MOVE] })));
    render(<SprintDailyDeltaPanel sprintId="s1" />);
    fireEvent.click(screen.getByText('Login flow'));
    expect(setSelectedTaskIdMock).toHaveBeenCalledWith('t1');
  });
});
