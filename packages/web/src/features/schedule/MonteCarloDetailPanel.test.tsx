import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MonteCarloDetailPanel } from './MonteCarloDetailPanel';
import { FIXTURE_MC_RESULT } from '@/fixtures/monteCarlo';
import type { Task } from '@/types';

const FIXTURE_TASKS: Task[] = [
  {
    id: 't1', name: 'Backend API', wbs: '1.1', duration: 20, start: '2026-09-01', finish: '2026-09-21',
    isSummary: false, isMilestone: false, isCritical: false, progress: 0, status: 'NOT_STARTED',
    plannedStart: null, notes: '', optimisticDuration: 12, pessimisticDuration: 28, mostLikelyDuration: 20,
    server_version: 1, projectId: 'proj-1',
  },
  {
    id: 't2', name: 'User testing', wbs: '1.2', duration: 10, start: '2026-10-01', finish: '2026-10-11',
    isSummary: false, isMilestone: false, isCritical: false, progress: 0, status: 'NOT_STARTED',
    plannedStart: null, notes: '', optimisticDuration: 7, pessimisticDuration: 16, mostLikelyDuration: 10,
    server_version: 1, projectId: 'proj-1',
  },
  {
    // Summary task — should be excluded from top drivers
    id: 't3', name: 'Phase 1', wbs: '1', duration: 30, start: '2026-09-01', finish: '2026-09-30',
    isSummary: true, isMilestone: false, isCritical: false, progress: 0, status: 'NOT_STARTED',
    plannedStart: null, notes: '', optimisticDuration: 20, pessimisticDuration: 40, mostLikelyDuration: 30,
    server_version: 1, projectId: 'proj-1',
  },
] as unknown as Task[];

describe('MonteCarloDetailPanel', () => {
  it('renders with role="dialog" when open', () => {
    render(
      <MonteCarloDetailPanel
        result={FIXTURE_MC_RESULT}
        cpmFinish="2026-10-05"
        tasks={[]}
        isOpen
        onClose={() => {}}
      />,
    );
    expect(screen.getAllByRole('dialog')[0]).toBeInTheDocument();
  });

  it('does not visually appear when isOpen=false (slide-out state)', () => {
    render(
      <MonteCarloDetailPanel
        result={FIXTURE_MC_RESULT}
        cpmFinish="2026-10-05"
        tasks={[]}
        isOpen={false}
        onClose={() => {}}
      />,
    );
    // Panel stays in the DOM for the slide-out transition but is set to
    // aria-hidden + invisible so AT and Playwright agree it is closed.
    const panel = screen.getByTestId('mc-detail-panel');
    expect(panel).toHaveAttribute('aria-hidden', 'true');
    expect(panel.className).toMatch(/invisible/);
    expect(panel.className).toMatch(/translate-x-full/);
  });

  it('fires onClose when the close button is clicked', () => {
    const onClose = vi.fn();
    render(
      <MonteCarloDetailPanel
        result={FIXTURE_MC_RESULT}
        cpmFinish="2026-10-05"
        tasks={[]}
        isOpen
        onClose={onClose}
      />,
    );
    // Both desktop and mobile dialogs render the close button; click the first.
    const desktopPanel = screen.getByTestId('mc-detail-panel');
    fireEvent.click(within(desktopPanel).getByRole('button', { name: /Close Monte Carlo detail panel/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('fires onClose on Escape key', () => {
    const onClose = vi.fn();
    render(
      <MonteCarloDetailPanel
        result={FIXTURE_MC_RESULT}
        cpmFinish="2026-10-05"
        tasks={[]}
        isOpen
        onClose={onClose}
      />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders the histogram SVG in the desktop panel', () => {
    render(
      <MonteCarloDetailPanel
        result={FIXTURE_MC_RESULT}
        cpmFinish="2026-10-05"
        tasks={[]}
        isOpen
        onClose={() => {}}
      />,
    );
    const desktopPanel = screen.getByTestId('mc-detail-panel');
    // MonteCarloHistogram renders an SVG with role="img"
    expect(within(desktopPanel).getByRole('img', { name: /Monte Carlo distribution/i })).toBeInTheDocument();
  });

  it('shows risk delta section when cpmFinish is provided', () => {
    render(
      <MonteCarloDetailPanel
        result={FIXTURE_MC_RESULT}
        cpmFinish="2026-10-05"
        tasks={[]}
        isOpen
        onClose={() => {}}
      />,
    );
    const desktopPanel = screen.getByTestId('mc-detail-panel');
    expect(within(desktopPanel).getByText(/Risk delta vs deterministic finish/i)).toBeInTheDocument();
  });

  it('omits risk delta section when cpmFinish is null', () => {
    render(
      <MonteCarloDetailPanel
        result={FIXTURE_MC_RESULT}
        cpmFinish={null}
        tasks={[]}
        isOpen
        onClose={() => {}}
      />,
    );
    expect(screen.queryByText(/Risk delta vs deterministic finish/i)).not.toBeInTheDocument();
  });

  it('shows P80 delta as positive days when P80 is later than CPM finish', () => {
    // FIXTURE_MC_RESULT.p80 = '2026-11-03', CPM finish = '2026-10-05' → +29d
    render(
      <MonteCarloDetailPanel
        result={FIXTURE_MC_RESULT}
        cpmFinish="2026-10-05"
        tasks={[]}
        isOpen
        onClose={() => {}}
      />,
    );
    const desktopPanel = screen.getByTestId('mc-detail-panel');
    expect(within(desktopPanel).getByText('+29d vs CPM')).toBeInTheDocument();
  });

  it('renders the sensitivity tornado joined to task names (ADR-0140)', () => {
    const result = {
      ...FIXTURE_MC_RESULT,
      sensitivity: [
        { taskId: 't1', index: 0.9 },
        { taskId: 't2', index: 0.4 },
        { taskId: 'gone', index: 0.99 }, // not in the task list → dropped, not nameless
      ],
    };
    render(
      <MonteCarloDetailPanel
        result={result}
        cpmFinish="2026-10-05"
        tasks={FIXTURE_TASKS}
        isOpen
        onClose={() => {}}
      />,
    );
    const desktopPanel = screen.getByTestId('mc-detail-panel');
    // Scope to the sensitivity section so the assertions don't collide with the
    // confidence-by-date percentages elsewhere in the panel.
    const section = within(desktopPanel)
      .getByText(/What.s holding the date/i)
      .closest('section')!;
    expect(within(section).getByText('Backend API')).toBeInTheDocument();
    expect(within(section).getByText('User testing')).toBeInTheDocument();
    expect(within(section).getByText('90%')).toBeInTheDocument();
    expect(within(section).getByText('40%')).toBeInTheDocument();
    // Exactly two bars render — the entry whose task is no longer present is
    // dropped rather than shown nameless (the third `gone` entry).
    expect(within(section).getAllByRole('img')).toHaveLength(2);
  });

  it('renders Confidence by date from the server confidenceCurve (no client re-derivation)', () => {
    // #987: the cumulative S-curve is now server-computed. The panel renders the
    // server `confidenceCurve` directly — it does NOT accumulate from buckets.
    // Buckets are deliberately left empty here to prove the rows come from the
    // curve, not the histogram.
    const result = {
      ...FIXTURE_MC_RESULT,
      buckets: [],
      confidenceCurve: [
        { date: '2026-05-31', pct: 12 },
        { date: '2026-06-07', pct: 28 },
        { date: '2026-06-14', pct: 47 },
        { date: '2026-06-21', pct: 70 },
        { date: '2026-06-28', pct: 91 },
      ],
    };
    render(
      <MonteCarloDetailPanel
        result={result}
        cpmFinish="2026-06-01"
        tasks={[]}
        isOpen
        onClose={() => {}}
      />,
    );
    const desktopPanel = screen.getByTestId('mc-detail-panel');
    const section = within(desktopPanel).getByText(/Confidence by date/i)
      .parentElement!;
    const dateLabels = within(section)
      .getAllByText(/^[A-Z][a-z]{2} \d{1,2}$/)
      .map((el) => el.textContent ?? '');
    // Display samples every other curve point plus the last, dropping pct ≤5 /
    // =100. From the 5-point curve above that yields the 1st, 3rd, and 5th
    // points (dates rendered short via Intl, which formats in local time).
    expect(dateLabels).toHaveLength(3);
    // Percent labels come straight from the rounded server pct.
    expect(within(section).getByText('12%')).toBeInTheDocument();
    expect(within(section).getByText('47%')).toBeInTheDocument();
    expect(within(section).getByText('91%')).toBeInTheDocument();
  });

  it('omits the Confidence by date section when the server confidenceCurve is empty (from-history past TTL)', () => {
    // Past the cache TTL the /latest/ payload is served from history: the raw
    // distribution is not persisted, so confidenceCurve (and buckets) come back
    // empty. The panel must degrade gracefully — render nothing — rather than
    // re-deriving the curve client-side.
    const result = {
      ...FIXTURE_MC_RESULT,
      buckets: [],
      confidenceCurve: [],
    };
    render(
      <MonteCarloDetailPanel
        result={result}
        cpmFinish="2026-10-05"
        tasks={[]}
        isOpen
        onClose={() => {}}
      />,
    );
    expect(screen.queryByText(/Confidence by date/i)).not.toBeInTheDocument();
  });

  it('reads risk deltas from the server deltaVsCpm, not a client subtraction', () => {
    // #987: deltas are server-computed. Override deltaVsCpm to a value that does
    // NOT match daysBetween(cpmFinish, pXX) to prove the panel reads the server
    // field rather than recomputing from the dates.
    const result = {
      ...FIXTURE_MC_RESULT,
      deltaVsCpm: { p50: 3, p80: 17, p95: 41 },
    };
    render(
      <MonteCarloDetailPanel
        result={result}
        cpmFinish="2026-10-05"
        tasks={[]}
        isOpen
        onClose={() => {}}
      />,
    );
    const desktopPanel = screen.getByTestId('mc-detail-panel');
    expect(within(desktopPanel).getByText('+3d vs CPM')).toBeInTheDocument();
    expect(within(desktopPanel).getByText('+17d vs CPM')).toBeInTheDocument();
    expect(within(desktopPanel).getByText('+41d vs CPM')).toBeInTheDocument();
  });

  it('shows the empty-sensitivity hint when the tornado is empty (from-history / deterministic)', () => {
    const result = { ...FIXTURE_MC_RESULT, sensitivity: [] };
    render(
      <MonteCarloDetailPanel
        result={result}
        cpmFinish={null}
        tasks={[]}
        isOpen
        onClose={() => {}}
      />,
    );
    const desktopPanel = screen.getByTestId('mc-detail-panel');
    expect(
      within(desktopPanel).getByText(/No task moved the finish enough to rank/i),
    ).toBeInTheDocument();
  });
});
