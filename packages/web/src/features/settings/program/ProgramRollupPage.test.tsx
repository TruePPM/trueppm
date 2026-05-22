import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProgramRollupPage } from './ProgramRollupPage';
import { ROLE_ADMIN, ROLE_MEMBER, ROLE_OWNER } from '@/lib/roles';
import type { ProgramRollupConfig } from './useProgramRollupConfig';

const useProgram = vi.fn();
const useProgramRollupConfig = vi.fn();
const toggleMutate = vi.fn();
const savePolicyMutate = vi.fn();
const refetch = vi.fn();

vi.mock('@/hooks/useProgram', () => ({
  useProgram: () => useProgram() as { data: unknown },
}));

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

  it('non-admin sees disabled controls and a Read-only pill', () => {
    useProgram.mockReturnValue({ data: { id: 'p-1', my_role: ROLE_MEMBER } });
    useProgramRollupConfig.mockReturnValue({
      data: defaultConfig(),
      isLoading: false,
      isError: false,
      refetch,
    });
    renderPage();

    expect(screen.getByText(/Read-only/)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Schedule health' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
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
});
