import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

  it('does not open a row-level popover or button on render', () => {
    render(<MonteCarloTimeline result={FIXTURE_MC_RESULT} />);
    // The original design opened a `role="dialog"` on the row's mouseenter and
    // that popover overlapped the unscheduled gutter above. Neither the row nor
    // the chips are buttons, and nothing opens until a chip is hovered/focused.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('no longer leans on a native `title` as the hover channel (#2389)', () => {
    const { container } = render(<MonteCarloTimeline result={FIXTURE_MC_RESULT} />);
    const row = container.firstChild as HTMLElement;
    // `title` is invisible to keyboard focus and unreachable on touch (rule 287).
    expect(row.getAttribute('title')).toBeNull();
  });

  it('explains each percentile on focus, not just the P80 headline', async () => {
    const user = userEvent.setup();
    render(<MonteCarloTimeline result={FIXTURE_MC_RESULT} />);

    await user.tab();
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      '50% of simulated runs finish on or before this date',
    );

    await user.tab();
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      '80% of simulated runs finish on or before this date',
    );

    await user.tab();
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      '95% of simulated runs finish on or before this date',
    );
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

  describe('UTC date rendering — no day-early shift for users west of UTC (#399)', () => {
    it('renders the ISO date as-is regardless of local timezone', () => {
      // "2026-11-14" must render as "Nov 14", never "Nov 13" (UTC midnight parsed in local zone).
      const result = {
        ...FIXTURE_MC_RESULT,
        p50: '2026-11-14',
        p80: '2026-11-14',
        p95: '2026-11-14',
      };
      render(<MonteCarloTimeline result={result} />);
      const p50 = screen.getByText(/^P50: /);
      expect(p50.textContent).toContain('Nov 14');
      expect(p50.textContent).not.toContain('Nov 13');
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

    it('keeps the converged-date guidance on the row aria-label', () => {
      const { container } = render(<MonteCarloTimeline result={COLLAPSED} />);
      const row = container.firstChild as HTMLElement;
      expect(row.getAttribute('aria-label')).toMatch(/Every simulation finished on/i);
      expect(row.getAttribute('aria-label')).toMatch(/Add PERT estimates/i);
    });

    it('surfaces that guidance on hover, where the removed `title` used to (#2389)', async () => {
      const user = userEvent.setup();
      render(<MonteCarloTimeline result={COLLAPSED} />);

      // A reader looking at three identical chips is asking "why are these the
      // same?", not "what does P80 mean" — so the collapse guidance replaces the
      // percentile sentence on every chip rather than sitting on the row alone.
      await user.hover(screen.getByText(/^P80: /));
      const tip = await screen.findByRole('tooltip');
      expect(tip).toHaveTextContent(/Every simulation finished on/i);
      expect(tip).toHaveTextContent(/Add PERT estimates/i);
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
