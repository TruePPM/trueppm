import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProgramGeneralPage } from './ProgramGeneralPage';
import { useSettingsSaveStore } from '../hooks/useSettingsSaveStore';
import type { Program } from '@/api/types';

const useProgram = vi.fn();
const mutateAsync = vi.fn();

vi.mock('@/hooks/useProgram', () => ({
  useProgram: () => useProgram() as { data: Program | undefined },
}));

vi.mock('@/hooks/useProgramMutations', () => ({
  useUpdateProgram: () => ({ mutateAsync }),
}));

function makeProgram(overrides: Partial<Program> = {}): Program {
  return {
    id: 'p-1',
    server_version: 1,
    name: 'Phase 2 Modernization',
    description: 'Q3 platform rebuild',
    code: 'PH2',
    methodology: 'HYBRID',
    health: 'AUTO',
    visibility: 'WORKSPACE',
    lead: 'u-1',
    lead_detail: { id: 'u-1', username: 'anika.k', email: 'anika@example.com' },
    created_by: 'u-1',
    created_at: '2026-05-18T00:00:00Z',
    updated_at: '2026-05-18T00:00:00Z',
    my_role: 400,
    my_role_label: 'Project Admin',
    project_count: 3,
    member_count: 5,
    is_closed: false,
    closed_at: null,
    closed_by: null,
    ...overrides,
  };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/programs/p-1/settings/general']}>
        <Routes>
          <Route path="/programs/:programId/settings/general" element={<ProgramGeneralPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ProgramGeneralPage (settings)', () => {
  beforeEach(() => {
    useProgram.mockReset();
    mutateAsync.mockReset();
    mutateAsync.mockResolvedValue(undefined);
    // The settings save store is module-scoped; reset between tests so a prior
    // page mount cannot leak its registered handlers into the next test.
    useSettingsSaveStore.getState().reset();
  });

  it('seeds field values from the API response on first load', () => {
    useProgram.mockReturnValue({ data: makeProgram() });
    renderPage();
    expect(screen.getByLabelText('Program name')).toHaveValue('Phase 2 Modernization');
    expect(screen.getByLabelText('Description')).toHaveValue('Q3 platform rebuild');
    expect(screen.getByLabelText('Program code')).toHaveValue('PH2');
    expect(screen.getByRole('button', { name: 'Auto', pressed: true })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hybrid', pressed: true })).toBeInTheDocument();
  });

  it('renders the lead username + initials when lead_detail is present', () => {
    useProgram.mockReturnValue({ data: makeProgram() });
    renderPage();
    expect(screen.getByText('anika.k')).toBeInTheDocument();
    // "anika.k" splits on "." → ["anika", "k"] → "AK"
    expect(screen.getByText('AK')).toBeInTheDocument();
  });

  it('renders the Unassigned placeholder when lead is null', () => {
    useProgram.mockReturnValue({
      data: makeProgram({ lead: null, lead_detail: null }),
    });
    renderPage();
    expect(screen.getByText(/Unassigned/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Assign/i })).toBeDisabled();
  });

  it('publishes apiReady=true and dirty=false to the settings save store once seeded', () => {
    useProgram.mockReturnValue({ data: makeProgram() });
    renderPage();
    const state = useSettingsSaveStore.getState();
    expect(state.apiReady).toBe(true);
    expect(state.dirty).toBe(false);
    expect(state.onSave).not.toBeNull();
    expect(state.onReset).not.toBeNull();
  });

  it('save handler PATCHes the consolidated patch payload', async () => {
    const user = userEvent.setup();
    useProgram.mockReturnValue({ data: makeProgram() });
    renderPage();

    const nameInput = screen.getByLabelText('Program name');
    await user.clear(nameInput);
    await user.type(nameInput, 'Phase 2 Rebuilt');

    // Flip health from Auto → Critical.
    await user.click(screen.getByRole('button', { name: 'Critical' }));

    // Trigger the save by calling the store's triggerSave directly, matching
    // what SettingsShell does on save-bar click or Ctrl/Cmd+S.
    await act(async () => {
      await useSettingsSaveStore.getState().triggerSave();
    });

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync).toHaveBeenCalledWith({
      programId: 'p-1',
      patch: {
        name: 'Phase 2 Rebuilt',
        description: 'Q3 platform rebuild',
        code: 'PH2',
        health: 'CRITICAL',
        methodology: 'HYBRID',
        visibility: 'WORKSPACE',
      },
    });
  });

  it('discard reverts edited fields back to the seeded initial values', async () => {
    const user = userEvent.setup();
    useProgram.mockReturnValue({ data: makeProgram() });
    renderPage();

    const nameInput = screen.getByLabelText('Program name');
    await user.clear(nameInput);
    await user.type(nameInput, 'Should Be Discarded');
    await user.click(screen.getByRole('button', { name: 'At risk' }));

    expect(nameInput).toHaveValue('Should Be Discarded');
    expect(screen.getByRole('button', { name: 'At risk', pressed: true })).toBeInTheDocument();

    act(() => {
      useSettingsSaveStore.getState().triggerDiscard();
    });

    expect(nameInput).toHaveValue('Phase 2 Modernization');
    expect(screen.getByRole('button', { name: 'Auto', pressed: true })).toBeInTheDocument();
  });
});
