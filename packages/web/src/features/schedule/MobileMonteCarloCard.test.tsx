import { screen, fireEvent, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { FIXTURE_MC_RESULT } from '@/fixtures/monteCarlo';
import type { UseMonteCarloResultReturn } from '@/hooks/useMonteCarloResult';
import { MobileMonteCarloCard } from './MobileMonteCarloCard';
import { ADDED_TIME_FIXTURES, ADDED_TIME_STATES } from '@/fixtures/addedTime';
import { addedTimePresentation, addedTimeShortForm } from '@/features/project/addedTime';

const useMonteCarloResultSpy = vi.hoisted(() =>
  vi.fn<(projectId?: string) => UseMonteCarloResultReturn>(),
);

vi.mock('@/hooks/useMonteCarloResult', () => ({
  useMonteCarloResult: (projectId?: string) => useMonteCarloResultSpy(projectId),
}));

const runMutate = vi.hoisted(() => vi.fn());
let runState: { isPending: boolean; isError: boolean } = { isPending: false, isError: false };

vi.mock('@/hooks/useRunMonteCarlo', () => ({
  useRunMonteCarlo: () => ({
    mutate: runMutate,
    isPending: runState.isPending,
    isError: runState.isError,
  }),
}));

// Opening the card mounts MonteCarloSheet, which now embeds
// ForecastHistorySection (#961). Stub the history hook so the sheet doesn't fire
// an unmocked apiClient request when the sheet opens.
vi.mock('@/hooks/useMonteCarloHistory', () => ({
  useMonteCarloHistory: () => ({
    data: [],
    cap: 100,
    // ForecastHistorySection gates on `enabled === false`; include it so the mock
    // matches UseMonteCarloHistoryReturn and the sheet renders the enabled state (#1365).
    enabled: true,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

beforeEach(() => {
  useMonteCarloResultSpy.mockReset();
  useMonteCarloResultSpy.mockReturnValue({
    data: FIXTURE_MC_RESULT,
    isLoading: false,
    error: null,
  });
  runMutate.mockReset();
  runState = { isPending: false, isError: false };
});

describe('MobileMonteCarloCard (#33)', () => {
  it('renders P50/P80/P95 chips with dates', () => {
    renderWithProviders(<MobileMonteCarloCard projectId="proj-1" />);
    const button = screen.getByRole('button', { name: /Monte Carlo confidence/ });
    expect(button).toHaveTextContent(/P50:/);
    expect(button).toHaveTextContent(/P80:/);
    expect(button).toHaveTextContent(/P95:/);
  });

  it('tap target meets the 44px minimum (rule 5)', () => {
    renderWithProviders(<MobileMonteCarloCard projectId="proj-1" />);
    const button = screen.getByRole('button', { name: /Monte Carlo confidence/ });
    // `min-h-11` = 44px floor
    expect(button.className).toMatch(/min-h-11/);
  });

  it('is suppressed at md and above (md:hidden class present)', () => {
    renderWithProviders(<MobileMonteCarloCard projectId="proj-1" />);
    const button = screen.getByRole('button', { name: /Monte Carlo confidence/ });
    expect(button.className).toMatch(/\bmd:hidden\b/);
  });

  it('opens the histogram sheet on tap and closes on Escape', () => {
    renderWithProviders(<MobileMonteCarloCard projectId="proj-1" />);
    const button = screen.getByRole('button', { name: /Monte Carlo confidence/ });
    fireEvent.click(button);

    const dialog = screen.getByRole('dialog', {
      name: /Monte Carlo confidence distribution/i,
    });
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveAttribute('aria-modal', 'true');

    // 44×44 close target
    const close = screen.getByRole('button', { name: /Close Monte Carlo detail/i });
    expect(close.className).toMatch(/w-11/);
    expect(close.className).toMatch(/h-11/);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(
      screen.queryByRole('dialog', { name: /Monte Carlo confidence distribution/i }),
    ).not.toBeInTheDocument();
  });

  it('renders nothing when no projectId is provided (no context to act on)', () => {
    useMonteCarloResultSpy.mockReturnValue({ data: undefined, isLoading: false, error: null });
    const { container } = renderWithProviders(<MobileMonteCarloCard />);
    expect(container.firstChild).toBeNull();
  });

  it('forwards projectId to useMonteCarloResult', () => {
    renderWithProviders(<MobileMonteCarloCard projectId="proj-xyz" />);
    expect(useMonteCarloResultSpy).toHaveBeenCalledWith('proj-xyz');
  });

  describe('empty state — no simulation cached', () => {
    beforeEach(() => {
      useMonteCarloResultSpy.mockReturnValue({ data: undefined, isLoading: false, error: null });
    });

    it('renders a "Run Monte Carlo" CTA in place of the chips', () => {
      renderWithProviders(<MobileMonteCarloCard projectId="proj-1" />);
      const cta = screen.getByRole('button', {
        name: /Run Monte Carlo simulation to see confidence dates/i,
      });
      expect(cta).toBeInTheDocument();
      expect(cta).toHaveTextContent(/No forecast yet\./);
      expect(cta).toHaveTextContent(/Run Monte Carlo/);
    });

    it('CTA still meets the 44px tap-target floor (rule 5)', () => {
      renderWithProviders(<MobileMonteCarloCard projectId="proj-1" />);
      const cta = screen.getByRole('button', {
        name: /Run Monte Carlo simulation to see confidence dates/i,
      });
      expect(cta.className).toMatch(/min-h-11/);
      expect(cta.className).toMatch(/\bmd:hidden\b/);
    });

    it('clicking the CTA fires the run mutation', () => {
      renderWithProviders(<MobileMonteCarloCard projectId="proj-1" />);
      fireEvent.click(
        screen.getByRole('button', {
          name: /Run Monte Carlo simulation to see confidence dates/i,
        }),
      );
      expect(runMutate).toHaveBeenCalledTimes(1);
    });

    it('disables the CTA and shows "Running…" while the mutation is pending', () => {
      runState = { isPending: true, isError: false };
      renderWithProviders(<MobileMonteCarloCard projectId="proj-1" />);
      const cta = screen.getByRole('button', {
        name: /Run Monte Carlo simulation to see confidence dates/i,
      });
      expect(cta).toBeDisabled();
      expect(cta).toHaveTextContent(/Running…/);
    });

    it('shows the loading copy while the latest-MC query is loading', () => {
      useMonteCarloResultSpy.mockReturnValue({ data: undefined, isLoading: true, error: null });
      renderWithProviders(<MobileMonteCarloCard projectId="proj-1" />);
      expect(screen.getByText(/Loading forecast…/i)).toBeInTheDocument();
    });

    it('shows a retry message when the run mutation errored', () => {
      runState = { isPending: false, isError: true };
      renderWithProviders(<MobileMonteCarloCard projectId="proj-1" />);
      expect(screen.getByText(/Could not run simulation\./i)).toBeInTheDocument();
      expect(screen.getByRole('button')).toHaveTextContent(/Try again/);
    });
  });
});

/**
 * #2531 DoD item 8 — the mobile card and the Overview card consume the *same*
 * premium object.
 *
 * The failure this rules out: the two surfaces read different sources, one of them
 * re-derives state from a raw day count, and a project with no estimates is told it
 * carries no schedule risk on a phone while the desktop card correctly says it cannot
 * be measured. Both are driven here from one fixture set for exactly that reason.
 */
describe('MobileMonteCarloCard added time (#2531)', () => {
  function renderWith(state: keyof typeof ADDED_TIME_FIXTURES) {
    useMonteCarloResultSpy.mockReturnValue({
      data: { ...FIXTURE_MC_RESULT, riskPremium: ADDED_TIME_FIXTURES[state] },
      isLoading: false,
      error: null,
    });
    renderWithProviders(<MobileMonteCarloCard projectId="proj-1" />);
    return screen.getByRole('button', { name: /Monte Carlo confidence/ });
  }

  it.each(ADDED_TIME_STATES)(
    'renders the same headline as AddedTimeCard for the %s state',
    (state) => {
      const facts = ADDED_TIME_FIXTURES[state];
      const button = renderWith(state);

      // The card is the reference rendering; the chip is a projection of the same
      // presentation, so whatever the card shows as its headline is what must
      // appear here — or, for the states the chip deliberately withholds, nothing.
      const expected = addedTimeShortForm(addedTimePresentation(facts), { qualified: false });
      if (expected === null) {
        // notRun / stale: the chip says nothing rather than saying it without its
        // provenance. The sheet still carries the full card. Asserted against the
        // premium's own value (+11d) rather than a digit pattern — the P80 forecast
        // chip beside it legitimately carries its own delta.
        expect(within(button).queryByText('+11d')).not.toBeInTheDocument();
        expect(within(button).queryByText('needs estimates')).not.toBeInTheDocument();
        expect(within(button).queryByText('No added time')).not.toBeInTheDocument();
      } else {
        expect(button).toHaveTextContent(expected.text);
      }
    },
  );

  it('shows "needs estimates" — never a calm zero — for an unestimated project', () => {
    const button = renderWith('unmeasurable');
    expect(button).toHaveTextContent('needs estimates');
    // The whole safety property in one assertion: no digit anywhere near the
    // added-time read for a project the simulation could not measure.
    expect(button).not.toHaveTextContent('+0d');
    expect(button).not.toHaveTextContent('0d');
  });

  it('names the added time in the accessible label, with the sign spoken as a word', () => {
    const button = renderWith('negative');
    // "−4d" read character-by-character loses the minus for some screen readers,
    // which flips "finishing early" into "finishing late".
    expect(button).toHaveAccessibleName(/4 days earlier than the computed finish/);
  });

  it('spells out an added premium against its baseline', () => {
    const button = renderWith('premium');
    expect(button).toHaveAccessibleName(/11 days added versus the computed finish/);
  });

  it('takes no health hue — added time is a magnitude, not a verdict', () => {
    const button = renderWith('premium');
    const chip = within(button).getByText('+11d');
    expect(chip.className).toContain('border-neutral-border');
    expect(chip.className).not.toMatch(/semantic-(critical|at-risk|on-track|warning)/);
  });

  it('says nothing about added time on a payload that predates the metric', () => {
    useMonteCarloResultSpy.mockReturnValue({
      data: { ...FIXTURE_MC_RESULT, riskPremium: undefined },
      isLoading: false,
      error: null,
    });
    renderWithProviders(<MobileMonteCarloCard projectId="proj-1" />);
    const button = screen.getByRole('button', { name: /Monte Carlo confidence/ });
    expect(button).not.toHaveTextContent('needs estimates');
  });
});
