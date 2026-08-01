import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProgramRollupPage } from './ProgramRollupPage';
import { ROLE_ADMIN, ROLE_MEMBER, ROLE_OWNER } from '@/lib/roles';
import type {
  AggregationPolicy,
  ProgramRollupConfig,
  RollupKpi,
  UnavailableKpiReason,
} from './useProgramRollupConfig';

interface MutateHandlers {
  onSuccess?: () => void;
  onError?: () => void;
}

const useProgram = vi.fn();
const useProgramRollupConfig = vi.fn();
const useProgramRollup = vi.fn();
const toggleMutate = vi.fn<(payload: RollupKpi[], handlers?: MutateHandlers) => void>();
const savePolicyMutate = vi.fn<(payload: AggregationPolicy, handlers?: MutateHandlers) => void>();
const refetch = vi.fn();
/** Mutable so a test can drive the policy mutation's in-flight branch. */
const savePolicyState = { isPending: false };

vi.mock('@/hooks/useProgram', () => ({
  useProgram: () => useProgram() as { data: unknown },
}));

// Partial mock: keep the real display helpers (renderKpi, HEALTH_*) used by the
// preview, override only the data hook so the preview is deterministic (#673).
vi.mock('@/features/programs/ProgramOverviewPage', async () => {
  const actual = await vi.importActual<typeof import('@/features/programs/ProgramOverviewPage')>(
    '@/features/programs/ProgramOverviewPage',
  );
  return { ...actual, useProgramRollup: () => useProgramRollup() as { data: unknown } };
});

vi.mock('./useProgramRollupConfig', async () => {
  const actual = await vi.importActual<typeof import('./useProgramRollupConfig')>(
    './useProgramRollupConfig',
  );
  return {
    ...actual,
    useProgramRollupConfig: () =>
      useProgramRollupConfig() as {
        data: ProgramRollupConfig | undefined;
        isLoading: boolean;
        isError: boolean;
        refetch: () => void;
      },
    useToggleProgramRollupKpi: () => ({ mutate: toggleMutate, isPending: false }),
    useSaveProgramRollupPolicy: () => ({
      mutate: savePolicyMutate,
      isPending: savePolicyState.isPending,
    }),
  };
});

function defaultConfig(overrides: Partial<ProgramRollupConfig> = {}): ProgramRollupConfig {
  return {
    enabled_kpis: ['schedule_health', 'p80_completion'],
    aggregation_policy: 'worst',
    // The real server always advertises these three (#2404). Note the default
    // config also has p80_completion already enabled — the stale-config case.
    unavailable_kpis: {
      cost_variance: 'no_cost_data',
      budget_utilization: 'no_cost_data',
      p80_completion: 'no_montecarlo_store',
    },
    ...overrides,
  };
}

interface RollupShape {
  aggregation_policy: string;
  policy_available: boolean;
  project_count: number;
  program_health: string;
  kpis: Record<string, unknown>;
}

function rollupResult(overrides: Partial<RollupShape> = {}) {
  return {
    data: {
      aggregation_policy: 'worst',
      policy_available: true,
      project_count: 2,
      program_health: 'at_risk',
      kpis: {
        schedule_health: { available: true, value: 'at_risk' },
        p80_completion: { available: false, reason: 'no_montecarlo_store' },
        ...overrides.kpis,
      },
      ...overrides,
    },
    isLoading: false,
    isError: false,
  };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/programs/p-1/settings/rollup']}>
        <Routes>
          <Route path="/programs/:programId/settings/rollup" element={<ProgramRollupPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ProgramRollupPage (settings)', () => {
  beforeEach(() => {
    useProgram.mockReset();
    useProgramRollupConfig.mockReset();
    useProgramRollup.mockReset();
    useProgramRollup.mockReturnValue(rollupResult());
    toggleMutate.mockReset();
    savePolicyMutate.mockReset();
    refetch.mockReset();
    savePolicyState.isPending = false;
  });

  it('renders KPI groups, current toggles, and policy radio', () => {
    useProgram.mockReturnValue({ data: { id: 'p-1', my_role: ROLE_OWNER } });
    useProgramRollupConfig.mockReturnValue({
      data: defaultConfig(),
      isLoading: false,
      isError: false,
      refetch,
    });
    renderPage();

    expect(screen.getByRole('heading', { name: /Rollup KPIs/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: /Schedule/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: /^Risk$/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: /^Cost$/ })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Schedule health' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('switch', { name: 'P80 completion date' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('switch', { name: 'At-risk tasks' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(screen.queryByTestId('stub-page-banner')).not.toBeInTheDocument();
  });

  it('non-admin sees read-only KPI values + policy (no disabled controls) and a Read-only pill', () => {
    useProgram.mockReturnValue({ data: { id: 'p-1', my_role: ROLE_MEMBER } });
    useProgramRollupConfig.mockReturnValue({
      // enabled: schedule_health + p80_completion; policy: worst.
      data: defaultConfig(),
      isLoading: false,
      isError: false,
      refetch,
    });
    renderPage();

    expect(screen.getByText(/Read-only/)).toBeInTheDocument();
    // No interactive switch — the on/off value + provenance is shown instead (ADR-0133).
    expect(screen.queryByRole('switch', { name: 'Schedule health' })).toBeNull();
    expect(
      screen.getByLabelText('Schedule health: On, managed by the program admin. View only.'),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText('At-risk tasks: Off, managed by the program admin. View only.'),
    ).toBeInTheDocument();
    // Aggregation policy renders read-only too.
    expect(
      screen.getByLabelText(
        'Aggregation policy: Worst-case (recommended), managed by the program admin. View only.',
      ),
    ).toBeInTheDocument();
  });

  // #2549: `rollup-config` PATCH is gated by IsProgramNotClosed, so an Admin on a
  // closed program must not see live toggles/radios that 403 on save.
  it('renders read-only KPI values + policy and a closed-specific pill for an Admin on a closed program', () => {
    useProgram.mockReturnValue({ data: { id: 'p-1', my_role: ROLE_ADMIN, is_closed: true } });
    useProgramRollupConfig.mockReturnValue({
      data: defaultConfig(),
      isLoading: false,
      isError: false,
      refetch,
    });
    renderPage();

    const pill = screen.getByTitle('This program is closed and cannot be modified. Reopen it first.');
    expect(pill).toHaveTextContent(/Read-only — program closed/i);
    expect(screen.queryByRole('switch', { name: 'Schedule health' })).toBeNull();
    expect(
      screen.getByLabelText(
        'Schedule health: On, program is closed — reopen it to change this. View only.',
      ),
    ).toBeInTheDocument();
  });

  it('renders a FieldHelp ⓘ on the Enabled KPIs + Aggregation policy section headers whose popover deep-links to the docs (#2266)', async () => {
    const user = userEvent.setup();
    useProgram.mockReturnValue({ data: { id: 'p-1', my_role: ROLE_ADMIN } });
    useProgramRollupConfig.mockReturnValue({
      data: defaultConfig(),
      isLoading: false,
      isError: false,
      refetch,
    });
    renderPage();

    // Each jargon-dense section header carries an ⓘ trigger named
    // "About the {label} options" (FieldHelp, web-rule 263).
    expect(
      screen.getByRole('button', { name: /About the Enabled KPIs options/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /About the Health aggregation policy options/i }),
    ).toBeInTheDocument();

    // Opening the KPIs help shows a non-modal dialog with a "Learn more →" link
    // deep-linking to the program-settings rollup docs anchor (web-rule 212).
    await user.click(screen.getByRole('button', { name: /About the Enabled KPIs options/i }));
    const dialog = screen.getByRole('dialog', { name: /Enabled KPIs/i });
    const learnMore = within(dialog).getByRole('link', { name: /Learn more/i });
    expect(learnMore).toHaveAttribute('href', expect.stringContaining('program-settings'));
  });

  it('keeps the FieldHelp ⓘ reachable for read-only viewers — this page has no StubFieldset (#2266)', () => {
    // Unlike ProgramGeneralPage (whose StubFieldset disables the ⓘ for
    // non-admins), this page never wraps its controls in a disabled fieldset,
    // so a Viewer/Member still gets contextual help even though every write
    // control is read-only. This is the read-only-reachable help deferred in MR3.
    useProgram.mockReturnValue({ data: { id: 'p-1', my_role: ROLE_MEMBER } });
    useProgramRollupConfig.mockReturnValue({
      data: defaultConfig(),
      isLoading: false,
      isError: false,
      refetch,
    });
    renderPage();

    expect(screen.getByText(/Read-only/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /About the Enabled KPIs options/i })).toBeEnabled();
    expect(
      screen.getByRole('button', { name: /About the Health aggregation policy options/i }),
    ).toBeEnabled();
  });

  it('toggling a KPI flips the switch immediately and PATCHes the new list after debounce', async () => {
    const user = userEvent.setup();
    useProgram.mockReturnValue({ data: { id: 'p-1', my_role: ROLE_ADMIN } });
    useProgramRollupConfig.mockReturnValue({
      data: defaultConfig({ enabled_kpis: ['schedule_health'] }),
      isLoading: false,
      isError: false,
      refetch,
    });
    renderPage();

    const sw = screen.getByRole('switch', { name: 'Critical task count' });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    await user.click(sw);
    expect(sw).toHaveAttribute('aria-checked', 'true');
    await waitFor(() => expect(toggleMutate).toHaveBeenCalledTimes(1), { timeout: 1000 });
    const [payload] = toggleMutate.mock.calls[0];
    expect(payload).toEqual(['schedule_health', 'critical_tasks']);
  });

  it('rapid toggles collapse into a single PATCH carrying the final state', async () => {
    const user = userEvent.setup();
    useProgram.mockReturnValue({ data: { id: 'p-1', my_role: ROLE_ADMIN } });
    useProgramRollupConfig.mockReturnValue({
      data: defaultConfig({ enabled_kpis: [] }),
      isLoading: false,
      isError: false,
      refetch,
    });
    renderPage();

    await user.click(screen.getByRole('switch', { name: 'Schedule health' }));
    await user.click(screen.getByRole('switch', { name: 'Critical task count' }));
    await user.click(screen.getByRole('switch', { name: 'Risk score' }));
    await waitFor(() => expect(toggleMutate).toHaveBeenCalledTimes(1), { timeout: 1000 });
    expect(toggleMutate.mock.calls[0][0]).toEqual([
      'schedule_health',
      'critical_tasks',
      'risk_score',
    ]);
  });

  it('policy radio shows the Unsaved changes bar on selection and Save fires the mutation', async () => {
    const user = userEvent.setup();
    useProgram.mockReturnValue({ data: { id: 'p-1', my_role: ROLE_OWNER } });
    useProgramRollupConfig.mockReturnValue({
      data: defaultConfig({ aggregation_policy: 'worst' }),
      isLoading: false,
      isError: false,
      refetch,
    });
    renderPage();

    expect(screen.queryByText(/Unsaved changes/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /Average/ }));
    expect(screen.getByText(/Unsaved changes/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Save$/ }));
    expect(savePolicyMutate).toHaveBeenCalledTimes(1);
    expect(savePolicyMutate.mock.calls[0][0]).toBe('average');
  });

  it('Discard restores the radio to the server value and hides the bar', async () => {
    const user = userEvent.setup();
    useProgram.mockReturnValue({ data: { id: 'p-1', my_role: ROLE_OWNER } });
    useProgramRollupConfig.mockReturnValue({
      data: defaultConfig({ aggregation_policy: 'worst' }),
      isLoading: false,
      isError: false,
      refetch,
    });
    renderPage();

    await user.click(screen.getByRole('radio', { name: /Budget-weighted/ }));
    expect(screen.getByText(/Unsaved changes/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Discard/ }));
    expect(screen.queryByText(/Unsaved changes/i)).not.toBeInTheDocument();
    expect(savePolicyMutate).not.toHaveBeenCalled();
  });

  it('loading state renders rule-248 skeleton ghosts without crashing', () => {
    useProgram.mockReturnValue({ data: { id: 'p-1', my_role: ROLE_OWNER } });
    useProgramRollupConfig.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      refetch,
    });
    renderPage();
    // Rule 248: named status nodes, never bare "Loading…" text (#2431).
    expect(screen.getAllByRole('status', { name: /^Loading / }).length).toBeGreaterThan(0);
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
  });

  it('error state shows Retry and refetches on click', async () => {
    const user = userEvent.setup();
    useProgram.mockReturnValue({ data: { id: 'p-1', my_role: ROLE_OWNER } });
    useProgramRollupConfig.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch,
    });
    renderPage();
    const retryButtons = screen.getAllByRole('button', { name: /Retry/ });
    // Both the KPI section and the policy section carry their own Retry.
    expect(retryButtons).toHaveLength(2);
    expect(screen.getByText("Couldn't load KPI settings.")).toBeInTheDocument();
    expect(screen.getByText("Couldn't load policy.")).toBeInTheDocument();
    await user.click(retryButtons[0]);
    expect(refetch).toHaveBeenCalledTimes(1);
    await user.click(retryButtons[1]);
    expect(refetch).toHaveBeenCalledTimes(2);
  });

  // --- Live preview (#673) -------------------------------------------------

  it('preview shows the program health pill and the policy/project subtitle', () => {
    useProgram.mockReturnValue({ data: { id: 'p-1', my_role: ROLE_OWNER } });
    useProgramRollupConfig.mockReturnValue({
      data: defaultConfig(),
      isLoading: false,
      isError: false,
      refetch,
    });
    renderPage();
    const preview = screen.getByRole('region', { name: 'Preview' });
    expect(within(preview).getByLabelText('Program health: At risk')).toBeInTheDocument();
    expect(within(preview).getByText('Worst-case across 2 projects')).toBeInTheDocument();
  });

  it('preview renders a deferred KPI as an em dash', () => {
    useProgram.mockReturnValue({ data: { id: 'p-1', my_role: ROLE_OWNER } });
    useProgramRollupConfig.mockReturnValue({
      data: defaultConfig(),
      isLoading: false,
      isError: false,
      refetch,
    });
    renderPage();
    const preview = screen.getByRole('region', { name: 'Preview' });
    expect(within(preview).getByText('P80 completion')).toBeInTheDocument();
    expect(within(preview).getByText('—')).toBeInTheDocument();
  });

  it('preview prompts to save the policy when a draft policy is selected', async () => {
    const user = userEvent.setup();
    useProgram.mockReturnValue({ data: { id: 'p-1', my_role: ROLE_OWNER } });
    useProgramRollupConfig.mockReturnValue({
      data: defaultConfig({ aggregation_policy: 'worst' }),
      isLoading: false,
      isError: false,
      refetch,
    });
    renderPage();
    const preview = screen.getByRole('region', { name: 'Preview' });
    expect(
      within(preview).queryByText(/Save the policy to see it reflected/i),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /Average/ }));
    expect(within(preview).getByText(/Save the policy to see it reflected/i)).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Unavailable KPIs (#2404) — a switch that cannot produce a value must not
  // be switchable on.
  // -------------------------------------------------------------------------

  describe('unavailable KPIs (#2404)', () => {
    beforeEach(() => {
      useProgram.mockReturnValue({ data: { id: 'p-1', my_role: ROLE_ADMIN } });
    });

    it('locks an unavailable KPI that is off and explains why', async () => {
      const user = userEvent.setup();
      useProgramRollupConfig.mockReturnValue({
        data: defaultConfig({ enabled_kpis: ['schedule_health'] }),
        isLoading: false,
        isError: false,
        refetch,
      });
      renderPage();

      const cv = screen.getByRole('switch', { name: 'Cost variance (CV)' });
      expect(cv).toHaveAttribute('aria-checked', 'false');
      expect(cv).toHaveAttribute('aria-disabled', 'true');
      // Both cost KPIs share the reason, so this is intentionally an AllBy.
      expect(screen.getAllByText(/needs project cost data to roll up/i)).toHaveLength(2);

      // Clicking must not fire the PATCH — the defect was that it saved fine
      // and then rendered nothing, forever.
      await user.click(cv);
      expect(toggleMutate).not.toHaveBeenCalled();
      expect(cv).toHaveAttribute('aria-checked', 'false');
    });

    it('describes the locked switch to assistive tech via aria-describedby', () => {
      useProgramRollupConfig.mockReturnValue({
        data: defaultConfig({ enabled_kpis: ['schedule_health'] }),
        isLoading: false,
        isError: false,
        refetch,
      });
      renderPage();

      const bu = screen.getByRole('switch', { name: 'Budget utilization' });
      const describedBy = bu.getAttribute('aria-describedby');
      expect(describedBy).toBeTruthy();
      // Must not dangle: the id has to resolve to the rendered explanation.
      expect(document.getElementById(describedBy as string)).toHaveTextContent(
        /needs project cost data/i,
      );
    });

    it('still lets an admin switch OFF an unavailable KPI that is already enabled', async () => {
      const user = userEvent.setup();
      useProgramRollupConfig.mockReturnValue({
        // Stale config from before the picker was locked.
        data: defaultConfig({ enabled_kpis: ['schedule_health', 'p80_completion'] }),
        isLoading: false,
        isError: false,
        refetch,
      });
      renderPage();

      const p80 = screen.getByRole('switch', { name: 'P80 completion date' });
      expect(p80).toHaveAttribute('aria-checked', 'true');
      expect(p80).not.toHaveAttribute('aria-disabled');
      expect(screen.getByText(/It is enabled but shows no value on the overview/i)).toBeVisible();

      await user.click(p80);
      await waitFor(() => expect(toggleMutate).toHaveBeenCalledTimes(1), { timeout: 1000 });
      expect(toggleMutate.mock.calls[0][0]).toEqual(['schedule_health']);
    });

    it('leaves available KPIs untouched', async () => {
      const user = userEvent.setup();
      useProgramRollupConfig.mockReturnValue({
        data: defaultConfig({ enabled_kpis: ['schedule_health'] }),
        isLoading: false,
        isError: false,
        refetch,
      });
      renderPage();

      const atRisk = screen.getByRole('switch', { name: 'At-risk tasks' });
      expect(atRisk).not.toHaveAttribute('aria-disabled');
      await user.click(atRisk);
      await waitFor(() => expect(toggleMutate).toHaveBeenCalledTimes(1), { timeout: 1000 });
      expect(toggleMutate.mock.calls[0][0]).toEqual(['schedule_health', 'at_risk_tasks']);
    });

    it('treats a response without unavailable_kpis as all-available', async () => {
      const user = userEvent.setup();
      useProgramRollupConfig.mockReturnValue({
        // A server predating #2404 (or a cached payload) omits the key.
        data: { enabled_kpis: ['schedule_health'], aggregation_policy: 'worst' },
        isLoading: false,
        isError: false,
        refetch,
      });
      renderPage();

      const cv = screen.getByRole('switch', { name: 'Cost variance (CV)' });
      expect(cv).not.toHaveAttribute('aria-disabled');
      expect(screen.queryByText(/Not yet available/i)).not.toBeInTheDocument();
      await user.click(cv);
      await waitFor(() => expect(toggleMutate).toHaveBeenCalledTimes(1), { timeout: 1000 });
      expect(toggleMutate.mock.calls[0][0]).toEqual(['schedule_health', 'cost_variance']);
    });

    it('falls back to a generic sentence for a reason the client does not know yet', () => {
      // The server owns this vocabulary and may ship a new reason before the
      // web package has a matching label — the row must still read sensibly.
      const futureReason = 'no_velocity_history' as unknown as UnavailableKpiReason;
      useProgramRollupConfig.mockReturnValue({
        data: defaultConfig({
          enabled_kpis: ['schedule_health'],
          unavailable_kpis: { risk_score: futureReason },
        }),
        isLoading: false,
        isError: false,
        refetch,
      });
      renderPage();

      expect(screen.getByText('Not yet available in this release.')).toBeInTheDocument();
      expect(screen.getByRole('switch', { name: 'Risk score' })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
    });

    it('leaves a KPI with no entry in unavailable_kpis switchable', () => {
      useProgramRollupConfig.mockReturnValue({
        data: defaultConfig({ enabled_kpis: [], unavailable_kpis: {} }),
        isLoading: false,
        isError: false,
        refetch,
      });
      renderPage();

      expect(screen.getByRole('switch', { name: 'Cost variance (CV)' })).not.toHaveAttribute(
        'aria-disabled',
      );
      expect(screen.queryByText(/Not yet available/i)).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Save/PATCH outcomes — the inline toast is the only feedback these two
  // mutations give, so both arms of each handler need a case.
  // -------------------------------------------------------------------------

  describe('mutation outcomes', () => {
    beforeEach(() => {
      useProgram.mockReturnValue({ data: { id: 'p-1', my_role: ROLE_ADMIN } });
    });

    it('reverts the switch and raises an error toast when the KPI PATCH fails', async () => {
      const user = userEvent.setup();
      useProgramRollupConfig.mockReturnValue({
        data: defaultConfig({ enabled_kpis: ['schedule_health'] }),
        isLoading: false,
        isError: false,
        refetch,
      });
      toggleMutate.mockImplementation((_payload, handlers) => handlers?.onError?.());
      renderPage();

      const sw = screen.getByRole('switch', { name: 'Critical task count' });
      await user.click(sw);
      // Optimistic overlay flips first…
      expect(sw).toHaveAttribute('aria-checked', 'true');
      // …then the failed PATCH drops it back to the server's last-known state.
      await waitFor(
        () =>
          expect(screen.getByRole('alert')).toHaveTextContent('Could not save change — try again.'),
        { timeout: 1000 },
      );
      expect(sw).toHaveAttribute('aria-checked', 'false');
    });

    it('cancels an in-flight debounce when the page unmounts mid-toggle', async () => {
      const user = userEvent.setup();
      useProgramRollupConfig.mockReturnValue({
        data: defaultConfig({ enabled_kpis: [] }),
        isLoading: false,
        isError: false,
        refetch,
      });
      const { unmount } = renderPage();

      await user.click(screen.getByRole('switch', { name: 'At-risk tasks' }));
      // Navigating away before the 250ms debounce fires must not PATCH.
      unmount();
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(toggleMutate).not.toHaveBeenCalled();
    });

    it('confirms a successful policy save with a polite toast', async () => {
      const user = userEvent.setup();
      useProgramRollupConfig.mockReturnValue({
        data: defaultConfig({ aggregation_policy: 'worst' }),
        isLoading: false,
        isError: false,
        refetch,
      });
      savePolicyMutate.mockImplementation((_payload, handlers) => handlers?.onSuccess?.());
      renderPage();

      await user.click(screen.getByRole('radio', { name: /Average/ }));
      await user.click(screen.getByRole('button', { name: /^Save$/ }));

      const toast = screen.getByText('Saved.');
      expect(toast).toHaveAttribute('role', 'status');
      expect(toast).toHaveAttribute('aria-live', 'polite');
    });

    it('raises an assertive toast when the policy save fails', async () => {
      const user = userEvent.setup();
      useProgramRollupConfig.mockReturnValue({
        data: defaultConfig({ aggregation_policy: 'worst' }),
        isLoading: false,
        isError: false,
        refetch,
      });
      savePolicyMutate.mockImplementation((_payload, handlers) => handlers?.onError?.());
      renderPage();

      await user.click(screen.getByRole('radio', { name: /Task-weighted/ }));
      await user.click(screen.getByRole('button', { name: /^Save$/ }));

      const toast = screen.getByText('Could not save — try again.');
      expect(toast).toHaveAttribute('role', 'alert');
      expect(toast).toHaveAttribute('aria-live', 'assertive');
      // The bar stays up so the admin can retry — the draft is not discarded.
      expect(screen.getByText(/Unsaved changes/i)).toBeInTheDocument();
    });

    it('dismisses the toast on its own after six seconds', () => {
      // fireEvent (not userEvent) so the fake clock is not driven by the
      // user-event scheduler — this test only cares about the dismiss timer.
      vi.useFakeTimers();
      try {
        useProgramRollupConfig.mockReturnValue({
          data: defaultConfig({ aggregation_policy: 'worst' }),
          isLoading: false,
          isError: false,
          refetch,
        });
        savePolicyMutate.mockImplementation((_payload, handlers) => handlers?.onSuccess?.());
        renderPage();

        fireEvent.click(screen.getByRole('radio', { name: /Average/ }));
        fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
        expect(screen.getByText('Saved.')).toBeInTheDocument();

        act(() => {
          vi.advanceTimersByTime(6000);
        });
        expect(screen.queryByText('Saved.')).not.toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it('locks Save and Discard while the policy save is in flight', async () => {
      const user = userEvent.setup();
      useProgramRollupConfig.mockReturnValue({
        data: defaultConfig({ aggregation_policy: 'worst' }),
        isLoading: false,
        isError: false,
        refetch,
      });
      renderPage();
      await user.click(screen.getByRole('radio', { name: /Average/ }));

      // Re-render with the mutation in flight — the bar swaps to its busy state.
      savePolicyState.isPending = true;
      await user.click(screen.getByRole('radio', { name: /Budget-weighted/ }));

      expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
      expect(screen.getByRole('button', { name: /Discard/ })).toBeDisabled();
    });
  });

  // -------------------------------------------------------------------------
  // Guards and degenerate payloads.
  // -------------------------------------------------------------------------

  describe('guards and degenerate payloads', () => {
    it('renders nothing when the route carries no program id', () => {
      useProgram.mockReturnValue({ data: undefined });
      useProgramRollupConfig.mockReturnValue({
        data: undefined,
        isLoading: false,
        isError: false,
        refetch,
      });
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const { container } = render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/settings/rollup']}>
            <Routes>
              <Route path="/settings/rollup" element={<ProgramRollupPage />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
      expect(container).toBeEmptyDOMElement();
    });

    it('treats a viewer with no loaded program as read-only', () => {
      useProgram.mockReturnValue({ data: undefined });
      useProgramRollupConfig.mockReturnValue({
        data: defaultConfig(),
        isLoading: false,
        isError: false,
        refetch,
      });
      renderPage();
      expect(screen.getByText(/Read-only/)).toBeInTheDocument();
      expect(screen.queryByRole('switch')).toBeNull();
    });

    it('renders the section chrome but no rows when the config resolves to nothing', () => {
      useProgram.mockReturnValue({ data: { id: 'p-1', my_role: ROLE_OWNER } });
      useProgramRollupConfig.mockReturnValue({
        data: undefined,
        isLoading: false,
        isError: false,
        refetch,
      });
      renderPage();
      expect(screen.getByRole('heading', { name: 'Enabled KPIs' })).toBeInTheDocument();
      expect(screen.queryByRole('switch')).toBeNull();
      expect(screen.queryByRole('radio')).toBeNull();
    });

    it('shows the raw policy value when the server sends one the client cannot label', () => {
      const futurePolicy = 'risk_weighted' as unknown as AggregationPolicy;
      useProgram.mockReturnValue({ data: { id: 'p-1', my_role: ROLE_MEMBER } });
      useProgramRollupConfig.mockReturnValue({
        data: defaultConfig({ aggregation_policy: futurePolicy }),
        isLoading: false,
        isError: false,
        refetch,
      });
      renderPage();
      expect(
        screen.getByLabelText(
          'Aggregation policy: risk_weighted, managed by the program admin. View only.',
        ),
      ).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Live preview (#673) — every state the panel can be in.
  // -------------------------------------------------------------------------

  describe('preview states (#673)', () => {
    beforeEach(() => {
      useProgram.mockReturnValue({ data: { id: 'p-1', my_role: ROLE_OWNER } });
      useProgramRollupConfig.mockReturnValue({
        data: defaultConfig(),
        isLoading: false,
        isError: false,
        refetch,
      });
    });

    it('shows a named skeleton while the rollup loads', () => {
      useProgramRollup.mockReturnValue({ data: undefined, isLoading: true, isError: false });
      renderPage();
      const preview = screen.getByRole('region', { name: 'Preview' });
      expect(within(preview).getByRole('status', { name: 'Loading preview' })).toBeInTheDocument();
      expect(within(preview).queryByLabelText(/Program health/)).toBeNull();
    });

    it('shows an inline error when the rollup request fails', () => {
      useProgramRollup.mockReturnValue({ data: undefined, isLoading: false, isError: true });
      renderPage();
      const preview = screen.getByRole('region', { name: 'Preview' });
      expect(within(preview).getByRole('alert')).toHaveTextContent(
        "Couldn't load the preview.",
      );
    });

    it('renders the panel chrome and nothing else when the rollup resolves empty', () => {
      useProgramRollup.mockReturnValue({ data: undefined, isLoading: false, isError: false });
      renderPage();
      const preview = screen.getByRole('region', { name: 'Preview' });
      expect(
        within(preview).getByText(/How these settings roll up against your current project data/i),
      ).toBeInTheDocument();
      expect(within(preview).queryByLabelText(/Program health/)).toBeNull();
      expect(within(preview).queryByRole('alert')).toBeNull();
    });

    it('uses the singular noun for a one-project program', () => {
      useProgramRollup.mockReturnValue(rollupResult({ project_count: 1 }));
      renderPage();
      const preview = screen.getByRole('region', { name: 'Preview' });
      expect(within(preview).getByText('Worst-case across 1 project')).toBeInTheDocument();
    });

    it('prompts to add projects when the program has none', () => {
      useProgramRollup.mockReturnValue(rollupResult({ project_count: 0 }));
      renderPage();
      const preview = screen.getByRole('region', { name: 'Preview' });
      expect(
        within(preview).getByText('Add projects to the program to preview the rollup.'),
      ).toBeInTheDocument();
      // The KPI grid is suppressed entirely in this state.
      expect(within(preview).queryByText('Schedule health')).toBeNull();
    });

    it('prompts to enable a KPI when the program has projects but no enabled KPIs', () => {
      useProgramRollup.mockReturnValue(rollupResult({ project_count: 3, kpis: {} }));
      renderPage();
      const preview = screen.getByRole('region', { name: 'Preview' });
      expect(
        within(preview).getByText('No KPIs enabled — toggle one above to preview it.'),
      ).toBeInTheDocument();
    });

    it('titles a deferred KPI with its reason and leaves an available one untitled', () => {
      useProgramRollup.mockReturnValue(
        rollupResult({
          kpis: {
            critical_tasks: { available: true, value: 4 },
            p80_completion: { available: false, reason: 'no_montecarlo_store' },
          },
        }),
      );
      renderPage();
      const preview = screen.getByRole('region', { name: 'Preview' });
      // Muted deferred value carries its explanation as a tooltip.
      expect(within(preview).getByTitle('Needs a saved Monte Carlo run')).toHaveTextContent('—');
      // A live value is coloured by variant, not muted, and has no tooltip.
      const live = within(preview).getByText('4');
      expect(live).not.toHaveAttribute('title');
      expect(live.className).toContain('text-semantic-at-risk');
    });

    it('paints an unknown program health band as the neutral pill', () => {
      useProgramRollup.mockReturnValue(rollupResult({ program_health: 'unknown' }));
      renderPage();
      const preview = screen.getByRole('region', { name: 'Preview' });
      const pill = within(preview).getByLabelText('Program health: Unknown');
      expect(pill).toHaveTextContent('Unknown');
      expect(pill.className).toContain('text-neutral-text-disabled');
    });

    it('labels the subtitle with each aggregation policy the server can report', () => {
      useProgramRollup.mockReturnValue(rollupResult({ aggregation_policy: 'task_weighted' }));
      renderPage();
      const preview = screen.getByRole('region', { name: 'Preview' });
      expect(within(preview).getByText('Task-weighted across 2 projects')).toBeInTheDocument();
    });
  });
});
