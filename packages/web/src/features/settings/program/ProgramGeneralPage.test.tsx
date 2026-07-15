import { render, screen, act, within } from '@testing-library/react';
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

// The methodology picker reads the workspace override policy (ADR-0107). SUGGEST
// keeps the picker editable (the default OSS behavior); a separate test exercises
// the INHERIT lock.
const useWorkspaceSettings = vi.fn(() => ({
  data: { methodologyOverridePolicy: 'suggest' },
}));
vi.mock('../hooks/useWorkspaceSettings', () => ({
  useWorkspaceSettings: () => useWorkspaceSettings(),
}));

// The lead MemberPicker fetches the program roster; stub it so the test makes no
// network call. The resting lead row renders from the record's lead_detail, so an
// empty roster is fine here (the picker behavior itself is covered by
// EntitySelectCombobox.test.tsx).
vi.mock('@/features/programs/hooks/useProgramMembers', () => ({
  useProgramMembers: () => ({ data: [], isLoading: false }),
}));

function makeProgram(overrides: Partial<Program> = {}): Program {
  return {
    id: 'p-1',
    server_version: 1,
    name: 'Phase 2 Modernization',
    description: 'Q3 platform rebuild',
    code: 'PH2',
    methodology: 'HYBRID',
    effective_methodology: 'HYBRID',
    inherited_methodology: 'HYBRID',
    iteration_label: null,
    inherited_iteration_label: 'Sprint',
    public_sharing: null,
    allow_guests: null,
    effective_public_sharing: false,
    effective_allow_guests: true,
    inherited_public_sharing: false,
    inherited_allow_guests: true,
    mc_history_enabled: null,
    mc_history_retention_cap: null,
    mc_history_attribution_audience: null,
    effective_mc_history_enabled: true,
    effective_mc_history_retention_cap: 100,
    effective_mc_history_attribution_audience: 'ADMIN_OWNER',
    inherited_mc_history_enabled: true,
    inherited_mc_history_retention_cap: 100,
    inherited_mc_history_attribution_audience: 'ADMIN_OWNER',
    task_duration_change_percent_policy: null,
    effective_task_duration_change_percent_policy: 'keep',
    inherited_task_duration_change_percent_policy: 'keep',
    attachments_enabled: null,
    allowed_attachment_types: null,
    effective_attachments_enabled: true,
    effective_allowed_attachment_types: ['application/pdf'],
    inherited_attachments_enabled: true,
    inherited_allowed_attachment_types: ['application/pdf'],
    risk_slip_propagation: 'warn',
    risk_escalation_days: 3,
    health: 'AUTO',
    target_date: null,
    visibility: 'WORKSPACE',
    color: null,
    lead: 'u-1',
    lead_detail: { id: 'u-1', username: 'anika.k', email: 'anika@example.com' },
    created_by: 'u-1',
    created_at: '2026-05-18T00:00:00Z',
    updated_at: '2026-05-18T00:00:00Z',
    my_role: 400,
    my_role_label: 'Program Admin',
    project_count: 3,
    member_count: 5,
    is_sample: false,
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
    useWorkspaceSettings.mockReturnValue({
      data: { methodologyOverridePolicy: 'suggest' },
    });
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
    expect(screen.getByRole('radio', { name: 'Hybrid', checked: true })).toBeInTheDocument();
  });

  it('renders the duration-change policy control inheriting the workspace default', () => {
    useProgram.mockReturnValue({ data: makeProgram() });
    renderPage();
    const group = screen.getByRole('radiogroup', { name: 'Duration change percent policy' });
    expect(group).toBeInTheDocument();
    // Fixture override is null → inheriting; the inherited value ('keep') surfaces
    // via the "Inherit (Keep entered %)" chip.
    expect(within(group).getByText(/Keep entered %/)).toBeInTheDocument();
  });

  it('re-seeds the form when the program in the route changes (no remount)', () => {
    useProgram.mockReturnValue({ data: makeProgram() });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // Fresh element each call so React re-renders (identical references bail
    // out); same queryClient + matching types preserve the page instance —
    // a route param change without a remount.
    const tree = () => (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/programs/p-1/settings/general']}>
          <Routes>
            <Route path="/programs/:programId/settings/general" element={<ProgramGeneralPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
    const { rerender } = render(tree());
    expect(screen.getByLabelText('Program name')).toHaveValue('Phase 2 Modernization');

    // Switch programs — same component instance, no remount. The one-shot seed
    // guard regression (#750) would strand 'Phase 2 Modernization' here.
    useProgram.mockReturnValue({
      data: makeProgram({ id: 'p-2', name: 'Apollo Program', code: 'APOLLO' }),
    });
    rerender(tree());

    expect(screen.getByLabelText('Program name')).toHaveValue('Apollo Program');
    expect(screen.getByLabelText('Program code')).toHaveValue('APOLLO');
  });

  it('renders the lead username + initials when lead_detail is present', () => {
    useProgram.mockReturnValue({ data: makeProgram() });
    renderPage();
    expect(screen.getByText('anika.k')).toBeInTheDocument();
    // "anika.k" splits on "." → ["anika", "k"] → "AK"
    expect(screen.getByText('AK')).toBeInTheDocument();
  });

  it('renders the Unassigned placeholder + an enabled Assign trigger when lead is null (#966)', () => {
    useProgram.mockReturnValue({
      data: makeProgram({ lead: null, lead_detail: null }),
    });
    renderPage();
    expect(screen.getByText(/Unassigned/i)).toBeInTheDocument();
    // The picker is wired now — the trigger is enabled, not a #966 stub.
    expect(screen.getByRole('button', { name: /Assign/i })).toBeEnabled();
  });

  it('opens the member picker from the lead Change trigger (#966)', async () => {
    const user = userEvent.setup();
    useProgram.mockReturnValue({ data: makeProgram() });
    renderPage();
    const change = screen.getByRole('button', { name: 'Change' });
    expect(change).toBeEnabled();
    await user.click(change);
    expect(screen.getByRole('listbox', { name: 'Select program manager' })).toBeInTheDocument();
  });

  it('publishes apiReady=true and dirty=false to the settings save store once seeded', () => {
    useProgram.mockReturnValue({ data: makeProgram() });
    renderPage();
    const state = useSettingsSaveStore.getState();
    expect(state.apiReady).toBe(true);
    expect(state.dirty).toBe(false);
    const entry = Object.values(state.sections)[0];
    expect(entry?.onSave).toBeTypeOf('function');
    expect(entry?.onReset).toBeTypeOf('function');
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
        target_date: null,
        methodology: 'HYBRID',
        iteration_label: null,
        public_sharing: null,
        allow_guests: null,
        visibility: 'WORKSPACE',
        color: null,
        lead: 'u-1',
        mc_history_enabled: null,
        mc_history_retention_cap: null,
        mc_history_attribution_audience: null,
        task_duration_change_percent_policy: null,
      },
    });
  });

  it('seeds, edits, and saves the target date as an ISO string (#560)', async () => {
    const user = userEvent.setup();
    useProgram.mockReturnValue({ data: makeProgram({ target_date: '2026-09-30' }) });
    renderPage();

    const input = screen.getByLabelText('Program target date');
    expect(input).toHaveValue('2026-09-30'); // seeded from the API
    expect(useSettingsSaveStore.getState().dirty).toBe(false);

    await user.clear(input);
    await user.type(input, '2026-12-31');
    expect(useSettingsSaveStore.getState().dirty).toBe(true);

    await act(async () => {
      await useSettingsSaveStore.getState().triggerSave();
    });
    const saved = mutateAsync.mock.calls.at(-1)?.[0] as {
      programId: string;
      patch: { target_date: string | null };
    };
    expect(saved.programId).toBe('p-1');
    expect(saved.patch.target_date).toBe('2026-12-31');
  });

  it('normalizes a cleared target date to null on save (#560)', async () => {
    const user = userEvent.setup();
    useProgram.mockReturnValue({ data: makeProgram({ target_date: '2026-09-30' }) });
    renderPage();

    await user.clear(screen.getByLabelText('Program target date'));
    await act(async () => {
      await useSettingsSaveStore.getState().triggerSave();
    });
    const saved = mutateAsync.mock.calls.at(-1)?.[0] as {
      patch: { target_date: string | null };
    };
    expect(saved.patch.target_date).toBeNull();
  });

  it('selecting an accent swatch marks the form dirty and saves the chosen hex', async () => {
    const user = userEvent.setup();
    useProgram.mockReturnValue({ data: makeProgram() });
    renderPage();

    // Seeded with no color → store starts clean.
    expect(useSettingsSaveStore.getState().dirty).toBe(false);

    await user.click(screen.getByRole('button', { name: /Accent color #0EA5E9/i }));
    expect(useSettingsSaveStore.getState().dirty).toBe(true);
    expect(screen.getByRole('button', { name: /Accent color #0EA5E9/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await act(async () => {
      await useSettingsSaveStore.getState().triggerSave();
    });

    expect(mutateAsync).toHaveBeenCalledWith({
      programId: 'p-1',
      patch: {
        name: 'Phase 2 Modernization',
        description: 'Q3 platform rebuild',
        code: 'PH2',
        health: 'AUTO',
        target_date: null,
        methodology: 'HYBRID',
        iteration_label: null,
        public_sharing: null,
        allow_guests: null,
        visibility: 'WORKSPACE',
        color: '#0EA5E9',
        lead: 'u-1',
        mc_history_enabled: null,
        mc_history_retention_cap: null,
        mc_history_attribution_audience: null,
        task_duration_change_percent_policy: null,
      },
    });
  });

  it('clicking the active swatch clears the accent back to null', async () => {
    const user = userEvent.setup();
    useProgram.mockReturnValue({ data: makeProgram({ color: '#7C3AED' }) });
    renderPage();

    const swatch = screen.getByRole('button', { name: /Accent color #7C3AED/i });
    expect(swatch).toHaveAttribute('aria-pressed', 'true');

    // Toggle off via the swatch itself.
    await user.click(swatch);
    expect(swatch).toHaveAttribute('aria-pressed', 'false');
    expect(useSettingsSaveStore.getState().dirty).toBe(true);

    await act(async () => {
      await useSettingsSaveStore.getState().triggerSave();
    });
    expect(mutateAsync).toHaveBeenCalledWith({
      programId: 'p-1',
      patch: {
        name: 'Phase 2 Modernization',
        description: 'Q3 platform rebuild',
        code: 'PH2',
        health: 'AUTO',
        target_date: null,
        methodology: 'HYBRID',
        iteration_label: null,
        public_sharing: null,
        allow_guests: null,
        visibility: 'WORKSPACE',
        color: null,
        lead: 'u-1',
        mc_history_enabled: null,
        mc_history_retention_cap: null,
        mc_history_attribution_audience: null,
        task_duration_change_percent_policy: null,
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

  // ----- Role gating (#1084) -------------------------------------------------

  it('renders every field read-only for a sub-Admin (Member) my_role', () => {
    useProgram.mockReturnValue({ data: makeProgram({ my_role: 100 }) });
    renderPage();

    expect(screen.getByLabelText('Program name')).toBeDisabled();
    expect(screen.getByLabelText('Program code')).toBeDisabled();
    expect(screen.getByLabelText('Description')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Auto' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Hybrid' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Export to JSON/i })).toBeDisabled();
    // The manager picker drops its trigger entirely (rule 156 read-only render).
    expect(screen.queryByRole('button', { name: 'Change' })).not.toBeInTheDocument();
  });

  it('keeps the form editable for an Admin my_role', () => {
    useProgram.mockReturnValue({ data: makeProgram({ my_role: 300 }) });
    renderPage();

    expect(screen.getByLabelText('Program name')).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Change' })).toBeEnabled();
  });

  // ----- Export parity naming + async bundle (#1958) -------------------------

  it('labels the sync seed card "Export program" (object-explicit naming)', () => {
    useProgram.mockReturnValue({ data: makeProgram({ my_role: 300 }) });
    renderPage();
    // The FieldRow label makes project-vs-program export unambiguous.
    expect(screen.getByText('Export program')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Export to JSON/i })).toBeInTheDocument();
  });

  it('renders the async "Export program bundle" card', () => {
    useProgram.mockReturnValue({ data: makeProgram({ my_role: 300 }) });
    renderPage();
    expect(screen.getByText('Export program bundle')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Export program bundle/i }),
    ).toBeInTheDocument();
  });

  // ----- Methodology cascade lock (ADR-0107, issue 955) ----------------------

  it('locks the methodology picker (but not other fields) under a workspace INHERIT policy', () => {
    // The program is an Admin (would normally edit), but the workspace requires
    // every program to inherit its default — so only the methodology picker is
    // read-only, and it shows the workspace-resolved value, not the program's
    // own stored override.
    useWorkspaceSettings.mockReturnValue({
      data: { methodologyOverridePolicy: 'inherit' },
    });
    useProgram.mockReturnValue({
      data: makeProgram({
        my_role: 300,
        methodology: 'AGILE',
        effective_methodology: 'WATERFALL',
      }),
    });
    renderPage();

    // Methodology radios are locked and reflect the workspace default (WATERFALL),
    // not the program's own AGILE override.
    expect(screen.getByRole('radio', { name: 'Waterfall' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Waterfall', checked: true })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Agile', checked: false })).toBeInTheDocument();
    // Other fields remain editable for the Admin.
    expect(screen.getByLabelText('Program name')).not.toBeDisabled();
  });
});
