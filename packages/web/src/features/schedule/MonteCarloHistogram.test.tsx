import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { FIXTURE_MC_RESULT } from '@/fixtures/monteCarlo';
import { MonteCarloHistogram } from './MonteCarloHistogram';

describe('MonteCarloHistogram', () => {
  it('renders an accessible SVG with a descriptive label', () => {
    renderWithProviders(<MonteCarloHistogram result={FIXTURE_MC_RESULT} />);
    const svg = screen.getByRole('img');
    expect(svg).toHaveAttribute(
      'aria-label',
      expect.stringContaining('P50'),
    );
    expect(svg).toHaveAttribute(
      'aria-label',
      expect.stringContaining('P80'),
    );
  });

  it('renders the correct number of bars (one per bucket)', () => {
    const { container } = renderWithProviders(
      <MonteCarloHistogram result={FIXTURE_MC_RESULT} />,
    );
    // Each bucket becomes one <rect> bar (plus none from rules which are <line>)
    const rects = container.querySelectorAll('rect');
    expect(rects).toHaveLength(FIXTURE_MC_RESULT.buckets.length);
  });

  it('renders histogram bars at the ≥3:1 chart-neutral mark, not the 2.70:1 disabled token (#2207, WCAG 1.4.11)', () => {
    const { container } = renderWithProviders(
      <MonteCarloHistogram result={FIXTURE_MC_RESULT} />,
    );
    const rects = container.querySelectorAll('rect');
    expect(rects.length).toBeGreaterThan(0);
    for (const rect of rects) {
      const cls = rect.getAttribute('class') ?? '';
      expect(cls).toContain('fill-chart-neutral');
      expect(cls).not.toContain('fill-neutral-text-disabled');
    }
  });

  it('renders three percentile rules (P50/P80/P95)', () => {
    const { container } = renderWithProviders(
      <MonteCarloHistogram result={FIXTURE_MC_RESULT} />,
    );
    // Three <line> elements: P50, P80, P95 + one baseline = 4
    const lines = container.querySelectorAll('line');
    expect(lines).toHaveLength(4); // P50, P80, P95 + x-axis baseline
  });

  it('renders P80 as a dashed line', () => {
    const { container } = renderWithProviders(
      <MonteCarloHistogram result={FIXTURE_MC_RESULT} />,
    );
    const dashedLine = container.querySelector('line[stroke-dasharray="4 2"]');
    expect(dashedLine).toBeInTheDocument();
    expect(dashedLine).toHaveAttribute('aria-label', expect.stringContaining('P80'));
  });

  it('renders P95 as a dotted line', () => {
    const { container } = renderWithProviders(
      <MonteCarloHistogram result={FIXTURE_MC_RESULT} />,
    );
    const dottedLine = container.querySelector('line[stroke-dasharray="1 2"]');
    expect(dottedLine).toBeInTheDocument();
    expect(dottedLine).toHaveAttribute('aria-label', expect.stringContaining('P95'));
  });

  it('renders a <title> element for screen readers', () => {
    const { container } = renderWithProviders(
      <MonteCarloHistogram result={FIXTURE_MC_RESULT} />,
    );
    const title = container.querySelector('title');
    expect(title).not.toBeNull();
    expect(title?.textContent).toContain('P50');
  });

  describe('collapse case — single-bucket distribution', () => {
    const COLLAPSED: typeof FIXTURE_MC_RESULT = {
      ...FIXTURE_MC_RESULT,
      p50: '2026-11-30',
      p80: '2026-11-30',
      p95: '2026-11-30',
      buckets: [{ weekStart: '2026-11-30', count: 1000 }],
    };

    it('renders a prose summary instead of the SVG chart', () => {
      const { container } = renderWithProviders(
        <MonteCarloHistogram result={COLLAPSED} />,
      );
      expect(container.querySelector('svg')).toBeNull();
      expect(screen.getByText(/Every simulation finished on/i)).toBeInTheDocument();
    });

    it('mentions the converged date and offers PERT guidance', () => {
      renderWithProviders(<MonteCarloHistogram result={COLLAPSED} />);
      // The exact day-of-month depends on the host timezone (the local-zone
      // formatter shifts west of UTC). Assert only the year + month + that a
      // PERT hint is rendered, both of which are TZ-stable.
      expect(screen.getByText(/November.*2026|November 2026/)).toBeInTheDocument();
      expect(screen.getByText(/PERT estimates/i)).toBeInTheDocument();
    });

    it('detects collapse via percentile equality even when the API returns 30 buckets', () => {
      // Reproduces the real API shape: 30 buckets sharing one date, all weight
      // in bucket 0, percentile values identical. Without the percentile-equality
      // check the SVG draws a lonely bar at the left and three stacked rules
      // at index 29 with overlapping labels.
      const apiShape: typeof FIXTURE_MC_RESULT = {
        ...FIXTURE_MC_RESULT,
        p50: '2026-11-30',
        p80: '2026-11-30',
        p95: '2026-11-30',
        buckets: Array.from({ length: 30 }, (_, i) => ({
          weekStart: '2026-11-30',
          count: i === 0 ? 1000 : 0,
        })),
      };
      const { container } = renderWithProviders(<MonteCarloHistogram result={apiShape} />);
      expect(container.querySelector('svg')).toBeNull();
      expect(screen.getByText(/Every simulation finished on/i)).toBeInTheDocument();
    });

    it('exposes an accessible label on the prose summary', () => {
      renderWithProviders(<MonteCarloHistogram result={COLLAPSED} />);
      const region = screen.getByRole('img');
      expect(region).toHaveAttribute(
        'aria-label',
        expect.stringContaining('every simulation finished on'),
      );
    });

    it('shows the reason-specific guidance, not a PERT prompt, when estimates are pending (#1340)', () => {
      // The regression behind #1340: a flat forecast on a project that DOES have
      // three-point estimates (withheld pending approval) was told to "add PERT
      // estimates". With forecast_diagnostic the prose must name the real cause instead.
      const pending: typeof FIXTURE_MC_RESULT = {
        ...COLLAPSED,
        forecastDiagnostic: {
          deterministic: true,
          reason: 'estimates_pending_approval',
          tasksTotal: 5,
          tasksWithVariance: 0,
          tasksPendingApproval: 3,
          agileTasksWithoutVelocity: 0,
          tasksEstimatesBelowPlan: 0,
        },
      };
      renderWithProviders(<MonteCarloHistogram result={pending} />);
      expect(screen.getByText(/3 task estimates are awaiting approval/i)).toBeInTheDocument();
      expect(screen.queryByText(/Add PERT estimates/i)).not.toBeInTheDocument();
    });
  });

  describe('percentile label collision handling (#3736)', () => {
    function textByContent(container: HTMLElement, content: string) {
      return Array.from(container.querySelectorAll('text')).find(
        (el) => el.textContent === content,
      );
    }

    // Buckets one week apart; P80 and P95 land on adjacent buckets — the same
    // shape that produced the "P80P95" overlap on the Atlas sample program.
    // P50 sits several buckets to the left so it never collides with either.
    const ADJACENT: typeof FIXTURE_MC_RESULT = {
      ...FIXTURE_MC_RESULT,
      p50: '2026-09-07',
      p80: '2026-10-05',
      p95: '2026-10-12',
      buckets: [
        { weekStart: '2026-08-31', count: 5 },
        { weekStart: '2026-09-07', count: 40 },
        { weekStart: '2026-09-14', count: 80 },
        { weekStart: '2026-09-21', count: 120 },
        { weekStart: '2026-09-28', count: 150 },
        { weekStart: '2026-10-05', count: 90 },
        { weekStart: '2026-10-12', count: 40 },
        { weekStart: '2026-10-19', count: 10 },
      ],
    };

    it('renders P80 and P95 labels on different rows when their buckets are adjacent', () => {
      const { container } = renderWithProviders(<MonteCarloHistogram result={ADJACENT} />);
      const p80Label = textByContent(container, 'P80');
      const p95Label = textByContent(container, 'P95');
      expect(p80Label).toBeTruthy();
      expect(p95Label).toBeTruthy();
      const p80X = Number(p80Label!.getAttribute('x'));
      const p95X = Number(p95Label!.getAttribute('x'));
      const p80Y = Number(p80Label!.getAttribute('y'));
      const p95Y = Number(p95Label!.getAttribute('y'));
      // The rule lines stay one bucket pitch (10px) apart — close enough that
      // ~25px-wide "P80"/"P95" labels centered on them would overlap.
      expect(Math.abs(p80X - p95X)).toBeLessThan(15);
      // Without collision handling both labels sit at the same y and read as
      // "P80P95" — this is the assertion that must fail on the unpatched
      // component (verified: reverting the fix turns this red).
      expect(p80Y).not.toBe(p95Y);
    });

    it('keeps each rule line at its true bucket x-coordinate even when its label moves to a new row', () => {
      const { container } = renderWithProviders(<MonteCarloHistogram result={ADJACENT} />);
      const p95Line = container.querySelector('line[stroke-dasharray="1 2"]');
      const p95Label = textByContent(container, 'P95');
      expect(p95Line).toBeTruthy();
      expect(p95Label).toBeTruthy();
      // Same x as its label — collision handling may move a label's row (y)
      // but must never move the dashed/dotted/solid marker off the data x.
      expect(p95Line!.getAttribute('x1')).toBe(p95Label!.getAttribute('x'));
    });

    it('still renders the non-colliding P50 label at a valid row', () => {
      const { container } = renderWithProviders(<MonteCarloHistogram result={ADJACENT} />);
      const p50Label = textByContent(container, 'P50');
      expect(p50Label).toBeTruthy();
      expect(Number(p50Label!.getAttribute('y'))).toBeGreaterThan(0);
    });

    it('spreads all three labels across rows (not just a P80/P95 special case) when every percentile is adjacent', () => {
      // General N-label case: P50, P80 and P95 all fall on consecutive
      // buckets, so no two labels may safely share a row.
      const TIGHT: typeof FIXTURE_MC_RESULT = {
        ...FIXTURE_MC_RESULT,
        p50: '2026-09-28',
        p80: '2026-10-05',
        p95: '2026-10-12',
        buckets: [
          { weekStart: '2026-09-21', count: 20 },
          { weekStart: '2026-09-28', count: 150 },
          { weekStart: '2026-10-05', count: 90 },
          { weekStart: '2026-10-12', count: 40 },
          { weekStart: '2026-10-19', count: 10 },
        ],
      };
      const { container } = renderWithProviders(<MonteCarloHistogram result={TIGHT} />);
      const rows = ['P50', 'P80', 'P95'].map(
        (t) => Number(textByContent(container, t)!.getAttribute('y')),
      );
      // Three labels at one bucket pitch apart cannot all share a row without
      // overlapping — at least one must move.
      expect(new Set(rows).size).toBeGreaterThan(1);
    });

    it('keeps a single shared row when percentiles are spread far enough apart not to collide', () => {
      // Regression guard: the default fixture's percentiles are already spaced
      // wide enough (P50/P80/P95 several buckets apart) that no row change
      // should occur — the SVG height must stay at its original, single-row
      // size rather than always reserving extra vertical space.
      const { container } = renderWithProviders(
        <MonteCarloHistogram result={FIXTURE_MC_RESULT} />,
      );
      const rows = ['P50', 'P80', 'P95'].map(
        (t) => Number(textByContent(container, t)!.getAttribute('y')),
      );
      expect(new Set(rows).size).toBe(1);
    });
  });

  describe('cold / not-persisted case — empty buckets (#1231)', () => {
    it('shows a "run a fresh simulation" prompt, NOT the misleading converged-date prose', () => {
      // Distinct from the genuine zero-spread collapse: here there is no
      // distribution at all (run served from history past the cache TTL with no
      // persisted distribution, or never run). The component must not claim a
      // converged date it never had.
      const cold = {
        ...FIXTURE_MC_RESULT,
        // Non-equal percentiles so the collapse branch does NOT fire — only the
        // empty-buckets branch should.
        p50: '2026-10-05',
        p80: '2026-11-03',
        p95: '2026-11-30',
        buckets: [],
      };
      const { container } = renderWithProviders(<MonteCarloHistogram result={cold} />);
      expect(container.querySelector('svg')).toBeNull();
      expect(screen.getByText(/Run a fresh simulation to see the distribution/i)).toBeInTheDocument();
      expect(screen.queryByText(/Every simulation finished on/i)).not.toBeInTheDocument();
    });

    it('exposes an accessible label on the cold-state prompt', () => {
      const cold = {
        ...FIXTURE_MC_RESULT,
        p50: '2026-10-05',
        p80: '2026-11-03',
        p95: '2026-11-30',
        buckets: [],
      };
      renderWithProviders(<MonteCarloHistogram result={cold} />);
      const region = screen.getByRole('img');
      expect(region).toHaveAttribute(
        'aria-label',
        expect.stringContaining('run a fresh simulation'),
      );
    });
  });
});
