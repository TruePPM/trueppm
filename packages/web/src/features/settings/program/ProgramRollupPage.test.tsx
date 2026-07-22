import { render, screen, waitFor, within } from '@testing-library/react';
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
} from './useProgramRollupConfig';

const useProgram = vi.fn();
const useProgramRollupConfig = vi.fn();
const useProgramRollup = vi.fn();
const toggleMutate = vi.fn<(payload: RollupKpi[]) => void>();
const savePolicyMutate = vi.fn<(payload: AggregationPolicy) => void>();
const refetch = vi.fn();

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
    useSaveProgramRollupPolicy: () => ({ mutate: savePolicyMutate, isPending: false }),
  };
});

function defaultConfig(overrides: Partial<ProgramRollupConfig> = {}): ProgramRollupConfig {
  return {
    enabled_kpis: ['schedule_health', 'p80_completion'],
    aggregation_policy: 'worst',
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

  it('loading state renders Loading… without crashing', () => {
    useProgram.mockReturnValue({ data: { id: 'p-1', my_role: ROLE_OWNER } });
    useProgramRollupConfig.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      refetch,
    });
    renderPage();
    expect(screen.getAllByText(/Loading…/).length).toBeGreaterThan(0);
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
    expect(retryButtons.length).toBeGreaterThan(0);
    await user.click(retryButtons[0]);
    expect(refetch).toHaveBeenCalled();
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
});
