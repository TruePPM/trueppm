import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MonteCarloTimeline } from './MonteCarloTimeline';
import { FIXTURE_MC_RESULT } from '@/fixtures/monteCarlo';

describe('MonteCarloTimeline', () => {
  it('renders the three permanent percentile chips with colon separator', () => {
    render(<MonteCarloTimeline result={FIXTURE_MC_RESULT} />);
    expect(screen.getByText(/^P50: /)).toBeInTheDocument();
    expect(screen.getByText(/^P80: /)).toBeInTheDocument();
    expect(screen.getByText(/^P95: /)).toBeInTheDocument();
  });

  it('does not open a custom popover on hover (chips are static)', () => {
    render(<MonteCarloTimeline result={FIXTURE_MC_RESULT} />);
    // The previous design opened a `role="dialog"` on mouseenter and that
    // popover overlapped the unscheduled gutter above the row. The row is
    // now non-interactive — explanation lives in a browser-native `title`.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('exposes the plain-English headline as a `title` attribute on the row', () => {
    const { container } = render(<MonteCarloTimeline result={FIXTURE_MC_RESULT} />);
    const row = container.firstChild as HTMLElement;
    expect(row.getAttribute('title')).toMatch(/8 in 10 simulations finish by/i);
  });

  it('mirrors the headline as the row aria-label for screen readers', () => {
    render(<MonteCarloTimeline result={FIXTURE_MC_RESULT} />);
    const row = screen.getByLabelText(/8 in 10 simulations finish by/i);
    expect(row).toBeInTheDocument();
  });

  it('does not render the always-visible mini histogram strip', () => {
    // The strip was removed because real-world inputs (no PERT) collapse to a
    // single bar that misleads more than it informs. Distribution shape lives
    // in the dedicated MC views (MCResultPanel, MonteCarloSheet) — never here.
    const { container } = render(<MonteCarloTimeline result={FIXTURE_MC_RESULT} />);
    expect(container.querySelector('.bg-semantic-on-track\\/50')).toBeNull();
    expect(container.querySelector('.bg-semantic-at-risk\\/50')).toBeNull();
    expect(container.querySelector('.bg-semantic-critical\\/50')).toBeNull();
  });

  describe('P80 delta suffix (#333)', () => {
    it('appends (+Nd) to P80 chip when p80DeltaDays is positive', () => {
      render(<MonteCarloTimeline result={FIXTURE_MC_RESULT} p80DeltaDays={14} />);
      expect(screen.getByText(/^P80:.*\(\+14d\)/)).toBeInTheDocument();
    });

    it('does not append delta when p80DeltaDays is zero', () => {
      render(<MonteCarloTimeline result={FIXTURE_MC_RESULT} p80DeltaDays={0} />);
      const p80 = screen.getByText(/^P80: /);
      expect(p80.textContent).not.toContain('(+');
    });

    it('does not append delta when p80DeltaDays is null', () => {
      render(<MonteCarloTimeline result={FIXTURE_MC_RESULT} p80DeltaDays={null} />);
      const p80 = screen.getByText(/^P80: /);
      expect(p80.textContent).not.toContain('(+');
    });

    it('does not append delta when p80DeltaDays is negative (MC earlier than CPM)', () => {
      render(<MonteCarloTimeline result={FIXTURE_MC_RESULT} p80DeltaDays={-5} />);
      const p80 = screen.getByText(/^P80: /);
      expect(p80.textContent).not.toContain('(+');
    });
  });

  describe('collapse case — every simulation converged on one date', () => {
    const COLLAPSED: typeof FIXTURE_MC_RESULT = {
      ...FIXTURE_MC_RESULT,
      p50: '2026-11-30',
      p80: '2026-11-30',
      p95: '2026-11-30',
      buckets: [{ weekStart: '2026-11-30', count: 1000 }],
    };

    it('uses the converged-date title with a PERT-estimate hint', () => {
      const { container } = render(<MonteCarloTimeline result={COLLAPSED} />);
      const row = container.firstChild as HTMLElement;
      expect(row.getAttribute('title')).toMatch(/Every simulation finished on/i);
      expect(row.getAttribute('title')).toMatch(/Add PERT estimates/i);
    });

    it('still renders the three chips even when their dates are identical', () => {
      // The user is meant to see "P50: Nov 30 / P80: Nov 30 / P95: Nov 30" —
      // three identical chips are themselves the visual signal that the
      // simulation produced no spread.
      render(<MonteCarloTimeline result={COLLAPSED} />);
      expect(screen.getByText(/^P50: /)).toBeInTheDocument();
      expect(screen.getByText(/^P80: /)).toBeInTheDocument();
      expect(screen.getByText(/^P95: /)).toBeInTheDocument();
    });
  });
});
