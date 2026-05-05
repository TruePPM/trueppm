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
      // November 30, 2026 — the date all simulations converged on.
      expect(screen.getByText(/November 30, 2026/)).toBeInTheDocument();
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

    it('treats an empty buckets array the same as a single bucket', () => {
      const empty = { ...COLLAPSED, buckets: [] };
      const { container } = renderWithProviders(
        <MonteCarloHistogram result={empty} />,
      );
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
  });
});
