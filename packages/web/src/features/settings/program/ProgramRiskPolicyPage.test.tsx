import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProgramRiskPolicyPage } from './ProgramRiskPolicyPage';
import { useSettingsSaveStore } from '../hooks/useSettingsSaveStore';
import { ROLE_ADMIN, ROLE_MEMBER, ROLE_OWNER } from '@/lib/roles';
import type { ProgramRiskPolicy } from './useProgramRiskPolicy';

const useProgram = vi.fn();
const useProgramRiskPolicy = vi.fn();
const saveMutateAsync = vi.fn<(patch: Partial<ProgramRiskPolicy>) => Promise<ProgramRiskPolicy>>();
const refetch = vi.fn();

vi.mock('@/hooks/useProgram', () => ({
  useProgram: () => useProgram() as { data: unknown },
}));

vi.mock('./useProgramRiskPolicy', async () => {
  const actual = await vi.importActual<typeof import('./useProgramRiskPolicy')>(
    './useProgramRiskPolicy',
  );
  return {
    ...actual,
    useProgramRiskPolicy: () =>
      useProgramRiskPolicy() as {
        data: ProgramRiskPolicy | undefined;
        isLoading: boolean;
        isError: boolean;
        refetch: () => void;
      },
    useSaveProgramRiskPolicy: () => ({
      mutateAsync: saveMutateAsync,
      isPending: false,
    }),
  };
});

// Drive the route's :programId directly so a test can switch programs without
// remounting the page (react-router reuses the component across param changes).
// Vitest permits a `mock`-prefixed variable inside a hoisted factory.
let mockProgramId = 'p-1';
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();
  return { ...actual, useParams: () => ({ programId: mockProgramId }) };
});

function defaultPolicy(overrides: Partial<ProgramRiskPolicy> = {}): ProgramRiskPolicy {
  return { slip_propagation: 'warn', escalation_days: 3, ...overrides };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/programs/p-1/settings/risk']}>
        <Routes>
          <Route
            path="/programs/:programId/settings/risk"
            element={<ProgramRiskPolicyPage />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ProgramRiskPolicyPage (settings)', () => {
  beforeEach(() => {
    mockProgramId = 'p-1';
    useProgram.mockReset();
    useProgramRiskPolicy.mockReset();
    saveMutateAsync.mockReset();
    refetch.mockReset();
    saveMutateAsync.mockImplementation((patch) =>
      Promise.resolve({
        slip_propagation: patch.slip_propagation ?? 'warn',
        escalation_days: patch.escalation_days ?? 3,
      }),
    );
    // Save store is module-scoped — reset so handlers from prior tests don't leak.
    useSettingsSaveStore.getState().reset();
  });

  it('seeds field values from the API and shows the matrix', () => {
    useProgram.mockReturnValue({ data: { id: 'p-1', my_role: ROLE_OWNER } });
    useProgramRiskPolicy.mockReturnValue({
      data: defaultPolicy({ slip_propagation: 'block', escalation_days: 7 }),
      isLoading: false,
      isError: false,
      refetch,
    });
    renderPage();

    expect(screen.getByRole('heading', { name: /Risk & deps policy/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: /Risk matrix/i })).toBeInTheDocument();
    // Block radio is selected (its sr-only input is checked).
    expect(screen.getByRole('radio', { name: /Block & escalate/i })).toBeChecked();
    expect(screen.getByRole('spinbutton')).toHaveValue(7);
    expect(screen.queryByTestId('stub-page-banner')).not.toBeInTheDocument();
  });

  it('re-seeds when the program in the route changes (no remount)', () => {
    useProgram.mockReturnValue({ data: { id: 'p-1', my_role: ROLE_OWNER } });
    useProgramRiskPolicy.mockReturnValue({
      data: defaultPolicy({ slip_propagation: 'warn', escalation_days: 3 }),
      isLoading: false,
      isError: false,
      refetch,
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // Fresh element each call so React re-renders (an identical reference bails
    // out); the same queryClient + matching element types preserve the page
    // instance — a route param change without a remount.
    const tree = () => (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/programs/p-1/settings/risk']}>
          <Routes>
            <Route
              path="/programs/:programId/settings/risk"
              element={<ProgramRiskPolicyPage />}
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
    const { rerender } = render(tree());
    expect(screen.getByRole('radio', { name: /Warn only/i })).toBeChecked();
    expect(screen.getByRole('spinbutton')).toHaveValue(3);

    // Switch programs — same component instance, no remount. The one-shot seed
    // guard regression (#750) would strand the first program's policy here.
    mockProgramId = 'p-2';
    useProgramRiskPolicy.mockReturnValue({
      data: defaultPolicy({ slip_propagation: 'block', escalation_days: 14 }),
      isLoading: false,
      isError: false,
      refetch,
    });
    rerender(tree());

    expect(screen.getByRole('radio', { name: /Block & escalate/i })).toBeChecked();
    expect(screen.getByRole('spinbutton')).toHaveValue(14);
  });

  it('non-admin sees disabled fieldset and a Read-only pill', () => {
    useProgram.mockReturnValue({ data: { id: 'p-1', my_role: ROLE_MEMBER } });
    useProgramRiskPolicy.mockReturnValue({
      data: defaultPolicy(),
      isLoading: false,
      isError: false,
      refetch,
    });
    renderPage();

    expect(screen.getByText(/Read-only/)).toBeInTheDocument();
    // The slip radios live in a disabled fieldset.
    expect(screen.getByRole('radio', { name: /Warn only/i })).toBeDisabled();
    expect(screen.getByRole('spinbutton')).toBeDisabled();
  });

  it('publishes apiReady=true and dirty=false to the settings save store once seeded', () => {
    useProgram.mockReturnValue({ data: { id: 'p-1', my_role: ROLE_OWNER } });
    useProgramRiskPolicy.mockReturnValue({
      data: defaultPolicy(),
      isLoading: false,
      isError: false,
      refetch,
    });
    renderPage();
    const state = useSettingsSaveStore.getState();
    expect(state.apiReady).toBe(true);
    expect(state.dirty).toBe(false);
    const entry = Object.values(state.sections)[0];
    expect(entry?.onSave).toBeTypeOf('function');
    expect(entry?.onReset).toBeTypeOf('function');
  });

  it('flips dirty=true when the user changes the slip radio', async () => {
    const user = userEvent.setup();
    useProgram.mockReturnValue({ data: { id: 'p-1', my_role: ROLE_ADMIN } });
    useProgramRiskPolicy.mockReturnValue({
      data: defaultPolicy(),
      isLoading: false,
      isError: false,
      refetch,
    });
    renderPage();

    expect(useSettingsSaveStore.getState().dirty).toBe(false);
    await user.click(screen.getByRole('radio', { name: /Block & escalate/i }));
    expect(useSettingsSaveStore.getState().dirty).toBe(true);
  });

  it('save handler PATCHes the consolidated payload via the store', async () => {
    const user = userEvent.setup();
    useProgram.mockReturnValue({ data: { id: 'p-1', my_role: ROLE_OWNER } });
    useProgramRiskPolicy.mockReturnValue({
      data: defaultPolicy(),
      isLoading: false,
      isError: false,
      refetch,
    });
    renderPage();

    await user.click(screen.getByRole('radio', { name: /Block & escalate/i }));
    const dayInput = screen.getByRole('spinbutton');
    await user.clear(dayInput);
    await user.type(dayInput, '14');

    await act(async () => {
      await useSettingsSaveStore.getState().triggerSave();
    });

    expect(saveMutateAsync).toHaveBeenCalledTimes(1);
    expect(saveMutateAsync).toHaveBeenCalledWith({
      slip_propagation: 'block',
      escalation_days: 14,
    });
    // After save the snapshot bumps; dirty should drop back to false.
    expect(useSettingsSaveStore.getState().dirty).toBe(false);
  });

  it('discard reverts both fields back to their seeded values', async () => {
    const user = userEvent.setup();
    useProgram.mockReturnValue({ data: { id: 'p-1', my_role: ROLE_OWNER } });
    useProgramRiskPolicy.mockReturnValue({
      data: defaultPolicy({ slip_propagation: 'warn', escalation_days: 3 }),
      isLoading: false,
      isError: false,
      refetch,
    });
    renderPage();

    await user.click(screen.getByRole('radio', { name: /No action/i }));
    const dayInput = screen.getByRole('spinbutton');
    await user.clear(dayInput);
    await user.type(dayInput, '20');

    expect(screen.getByRole('radio', { name: /No action/i })).toBeChecked();
    expect(dayInput).toHaveValue(20);

    act(() => {
      useSettingsSaveStore.getState().triggerDiscard();
    });

    expect(screen.getByRole('radio', { name: /Warn only/i })).toBeChecked();
    expect(dayInput).toHaveValue(3);
  });

  it('out-of-range escalation_days surfaces an inline error and disarms the save bar', async () => {
    const user = userEvent.setup();
    useProgram.mockReturnValue({ data: { id: 'p-1', my_role: ROLE_OWNER } });
    useProgramRiskPolicy.mockReturnValue({
      data: defaultPolicy(),
      isLoading: false,
      isError: false,
      refetch,
    });
    renderPage();

    const dayInput = screen.getByRole('spinbutton');
    await user.clear(dayInput);
    await user.type(dayInput, '99');

    expect(screen.getByRole('alert')).toHaveTextContent(/1.*30/);
    // apiReady drops when the local range check fails so the shell save bar disarms.
    expect(useSettingsSaveStore.getState().apiReady).toBe(false);
  });

  it('loading state renders Loading… without crashing', () => {
    useProgram.mockReturnValue({ data: { id: 'p-1', my_role: ROLE_OWNER } });
    useProgramRiskPolicy.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      refetch,
    });
    renderPage();
    expect(screen.getByText(/Loading…/)).toBeInTheDocument();
  });

  it('error state shows Retry and refetches on click', async () => {
    const user = userEvent.setup();
    useProgram.mockReturnValue({ data: { id: 'p-1', my_role: ROLE_OWNER } });
    useProgramRiskPolicy.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch,
    });
    renderPage();
    await user.click(screen.getByRole('button', { name: /Retry/ }));
    expect(refetch).toHaveBeenCalled();
  });
});
