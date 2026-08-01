import { render, screen, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProgramGeneralPage } from './ProgramGeneralPage';
import { useSettingsSaveStore } from '../hooks/useSettingsSaveStore';
import type { ProgramExportJob } from '../hooks/useProgramExport';
import type { Program } from '@/api/types';
import { ROLE_VIEWER } from '@/lib/roles';

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

// --- Export controls -------------------------------------------------------
// Both export cards are driven by network hooks. Swap the hooks for plain
// scriptable objects so each lifecycle state (idle / queuing / building /
// ready / failed) is reachable without a server or a polling clock. The
// factories read the state objects lazily (inside the returned closures), which
// is what keeps them out of the vi.mock hoisting TDZ.

const seedMutate = vi.fn<(input: { programId: string; code?: string | null }) => void>();
const exportSeedState = { mutate: seedMutate, isPending: false, isError: false };
vi.mock('@/hooks/useProgramSeedIo', async (orig) => {
  const actual = await orig<typeof import('@/hooks/useProgramSeedIo')>();
  return { ...actual, useExportProgramSeed: () => exportSeedState };
});

const startMutate =
  vi.fn<(vars: void, opts?: { onSuccess?: (job: ProgramExportJob) => void }) => void>();
const startState: { mutate: typeof startMutate; isPending: boolean; error: unknown } = {
  mutate: startMutate,
  isPending: false,
  error: null,
};
const jobState: { data: ProgramExportJob | undefined } = { data: undefined };
const downloadMock =
  vi.fn<(programId: string, job: ProgramExportJob, code?: string | null) => Promise<void>>();

vi.mock('../hooks/useProgramExport', async (orig) => {
  const actual = await orig<typeof import('../hooks/useProgramExport')>();
  return {
    ...actual,
    useStartProgramExport: () => startState,
    // Mirrors the real hook's `enabled: jobId != null` gate — no job is polled
    // until the queue mutation reports one.
    useProgramExportJob: (_programId: string, jobId: string | null) => ({
      data: jobId ? jobState.data : undefined,
    }),
    downloadProgramExport: (programId: string, job: ProgramExportJob, code?: string | null) =>
      downloadMock(programId, job, code),
  };
});

function makeJob(over: Partial<ProgramExportJob> = {}): ProgramExportJob {
  return {
    id: 'job-1',
    status: 'pending',
    fileSize: null,
    errorDetail: '',
    expiresAt: null,
    createdAt: '2026-05-18T00:00:00Z',
    startedAt: null,
    completedAt: null,
    downloadUrl: null,
    ...over,
  };
}

function makeProgram(overrides: Partial<Program> = {}): Program {
  return {
    id: 'p-1',
    server_version: 1,
    is_pinned: false,
    name: 'Phase 2 Modernization',
    description: 'Q3 platform rebuild',
    code: 'PH2',
    calendar: null,
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
    estimation_scale: null,
    effective_estimation_scale: 'fibonacci',
    inherited_estimation_scale: 'fibonacci',
    attachments_enabled: null,
    allowed_attachment_types: null,
    effective_attachments_enabled: true,
    effective_allowed_attachment_types: ['application/pdf'],
    inherited_attachments_enabled: true,
    inherited_allowed_attachment_types: ['application/pdf'],
    mcp_enabled: null,
    effective_mcp_enabled: true,
    inherited_mcp_enabled: true,
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

/**
 * The same page mounted outside the `/programs/:programId/…` tree, so
 * `useParams()` yields no program id — the shape every "guard" branch on the
 * page keys off.
 */
function renderPageWithoutProgramId() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/settings/general']}>
        <Routes>
          <Route path="/settings/general" element={<ProgramGeneralPage />} />
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
    seedMutate.mockReset();
    exportSeedState.isPending = false;
    exportSeedState.isError = false;
    startMutate.mockReset();
    // The real mutation reports the queued job through onSuccess; the control
    // stores its id and starts polling.
    startMutate.mockImplementation((_vars, opts) => opts?.onSuccess?.(makeJob()));
    startState.isPending = false;
    startState.error = null;
    jobState.data = undefined;
    downloadMock.mockReset();
    downloadMock.mockResolvedValue(undefined);
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

  it('renders a FieldHelp ⓘ on jargon/policy/cascade fields whose popover deep-links to the docs (#2266)', async () => {
    const user = userEvent.setup();
    useProgram.mockReturnValue({ data: makeProgram() });
    renderPage();

    // The ⓘ trigger is a button named "About the {label} options" (FieldHelp,
    // web-rule 263). Self-evident fields (name, code, description) get no ⓘ.
    expect(screen.getByRole('button', { name: /About the Methodology options/i })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /About the Estimation scale options/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /About the Allow guests options/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /About the Program name options/i })).toBeNull();

    // Opening Methodology's help shows a non-modal dialog with a "Learn more →"
    // link pointing at the methodology-preset docs page (web-rule 212).
    await user.click(screen.getByRole('button', { name: /About the Methodology options/i }));
    const dialog = screen.getByRole('dialog', { name: /Methodology/i });
    const learnMore = within(dialog).getByRole('link', { name: /Learn more/i });
    expect(learnMore).toHaveAttribute(
      'href',
      expect.stringContaining('features/methodology-preset/'),
    );
  });

  it('hides the FieldHelp ⓘ for read-only viewers rather than rendering a disabled one (#2266)', () => {
    // The whole form sits in `<StubFieldset disabled={!canEdit}>` (#1084), whose
    // `<fieldset disabled>` would disable the ⓘ trigger <button> — a dead, dimmed
    // affordance (ux-review §8 / web-rule 122). Below Admin we render no trigger;
    // the always-visible inline hint still explains the field.
    useProgram.mockReturnValue({ data: makeProgram({ my_role: ROLE_VIEWER, my_role_label: 'Viewer' }) });
    renderPage();
    expect(screen.queryByRole('button', { name: /About the Methodology options/i })).toBeNull();
    // The inline hint the control describes by is unaffected (it is a <div>, not a
    // form control) — read-only users still get the plain-language explanation.
    expect(
      screen.getByText(/Default methodology for projects in this program/i),
    ).toBeInTheDocument();
  });

  // #2549: ProgramViewSet.update/partial_update is gated by IsProgramNotClosed,
  // so an Admin on a closed program must not see a live, saveable form.
  it('renders the whole form read-only for an Admin on a closed program, and says why', () => {
    useProgram.mockReturnValue({ data: makeProgram({ is_closed: true }) });
    renderPage();

    expect(screen.getByLabelText('Program name')).toBeDisabled();
    const notice = screen.getByTitle(
      'This program is closed and cannot be modified. Reopen it first.',
    );
    expect(notice).toHaveTextContent(/Read-only — program closed/i);
  });

  it('renders the visibility control disabled with a "not yet enforced" note (#2011)', () => {
    useProgram.mockReturnValue({ data: makeProgram() });
    renderPage();

    // Visibility is stored but access is membership-scoped for every program, so
    // both radios are disabled to avoid false assurance until enforcement ships
    // (TODO(#2066)).
    const radios = screen
      .getAllByRole('radio')
      .filter((el) => (el as HTMLInputElement).name === 'program-visibility');
    expect(radios).toHaveLength(2);
    radios.forEach((radio) => expect(radio).toBeDisabled());

    expect(
      screen.getByText(/access is currently membership-scoped for all programs/i),
    ).toBeInTheDocument();
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
        estimation_scale: null,
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
        estimation_scale: null,
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
        estimation_scale: null,
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

  it('shows the workspace-resolved default in the locked picker before the record loads', () => {
    // Under the INHERIT lock the picker shows `effective_methodology`; with no
    // record yet there is nothing to show, so it must fall back to the page's own
    // default rather than rendering an unchecked radiogroup.
    useWorkspaceSettings.mockReturnValue({
      data: { methodologyOverridePolicy: 'inherit' },
    });
    useProgram.mockReturnValue({ data: undefined });
    renderPage();

    expect(screen.getByRole('radio', { name: 'Hybrid', checked: true })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Hybrid' })).toBeDisabled();
  });

  // ----- Loading / partial records ------------------------------------------

  it('falls back to the shipped defaults for every inheritable field before the record loads', () => {
    useProgram.mockReturnValue({ data: undefined });
    renderPage();

    expect(screen.getByLabelText('Program name')).toHaveValue('');
    // No record → no role → the read-only indicators render, each showing the
    // value the program WOULD inherit rather than a blank.
    expect(
      screen.getByLabelText(/^Keep Monte Carlo run history: On, inherited from the workspace/),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText(/^Allow guest access: Off, inherited from the workspace/),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText(/^Allow public link sharing: Off, inherited from the workspace/),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText(/^Run history limit: 100, inherited from the workspace/),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText(/^Run attribution visible to: Admins & owners, inherited/),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText(/^Duration change percent policy: Keep entered %, inherited/),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/^Estimation scale: Fibonacci/)).toBeInTheDocument();
    // Iteration terminology inherits the shipped default term.
    expect(screen.getByText(/\(Sprint\)/)).toBeInTheDocument();

    // Nothing to save against yet, so the save bar must not arm.
    expect(useSettingsSaveStore.getState().apiReady).toBe(false);
  });

  it('seeds blank inputs for a program record that omits description and code', () => {
    // A sparse payload (older server, partial serializer) must render empty
    // inputs, not "undefined".
    useProgram.mockReturnValue({
      data: makeProgram({ description: undefined, code: undefined }),
    });
    renderPage();
    expect(screen.getByLabelText('Description')).toHaveValue('');
    expect(screen.getByLabelText('Program code')).toHaveValue('');
  });

  it('refuses every program-scoped action when the route carries no program id', async () => {
    const user = userEvent.setup();
    useProgram.mockReturnValue({ data: makeProgram() });
    renderPageWithoutProgramId();

    // The synchronous seed export needs an id, so its control stays disabled…
    expect(screen.getByRole('button', { name: /Export to JSON/i })).toBeDisabled();
    // …and the async bundle card is not rendered at all.
    expect(
      screen.queryByRole('button', { name: /Export program bundle/i }),
    ).not.toBeInTheDocument();

    // A dirty form still refuses to PATCH — there is no program to PATCH.
    await user.type(screen.getByLabelText('Program name'), '!');
    expect(useSettingsSaveStore.getState().dirty).toBe(true);
    await act(async () => {
      await useSettingsSaveStore.getState().triggerSave();
    });
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  // ----- Field edits reaching the patch -------------------------------------

  it('carries edited code and description into the save payload', async () => {
    const user = userEvent.setup();
    useProgram.mockReturnValue({ data: makeProgram() });
    renderPage();

    const code = screen.getByLabelText('Program code');
    await user.clear(code);
    await user.type(code, 'APOLLO');
    const description = screen.getByLabelText('Description');
    await user.clear(description);
    await user.type(description, 'Rebuilt on the new stack');
    expect(code).toHaveValue('APOLLO');

    await act(async () => {
      await useSettingsSaveStore.getState().triggerSave();
    });
    const saved = mutateAsync.mock.calls.at(-1)?.[0] as {
      patch: { code: string; description: string };
    };
    expect(saved.patch.code).toBe('APOLLO');
    expect(saved.patch.description).toBe('Rebuilt on the new stack');
  });

  it('switches the methodology and saves the chosen model', async () => {
    const user = userEvent.setup();
    useProgram.mockReturnValue({ data: makeProgram() });
    renderPage();

    await user.click(screen.getByRole('radio', { name: 'Agile' }));
    expect(screen.getByRole('radio', { name: 'Agile', checked: true })).toBeInTheDocument();

    await act(async () => {
      await useSettingsSaveStore.getState().triggerSave();
    });
    const saved = mutateAsync.mock.calls.at(-1)?.[0] as { patch: { methodology: string } };
    expect(saved.patch.methodology).toBe('AGILE');
  });

  it('clears the accent from the Clear action beside the swatches', async () => {
    const user = userEvent.setup();
    useProgram.mockReturnValue({ data: makeProgram({ color: '#7C3AED' }) });
    renderPage();

    expect(screen.getByRole('button', { name: /Accent color #7C3AED/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(screen.getByRole('button', { name: 'Clear' }));

    expect(screen.getByRole('button', { name: /Accent color #7C3AED/i })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    // With no accent left there is nothing to clear — the action retires.
    expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument();

    await act(async () => {
      await useSettingsSaveStore.getState().triggerSave();
    });
    const saved = mutateAsync.mock.calls.at(-1)?.[0] as { patch: { color: string | null } };
    expect(saved.patch.color).toBeNull();
  });

  it('saves a custom iteration label verbatim (ADR-0116)', async () => {
    const user = userEvent.setup();
    useProgram.mockReturnValue({ data: makeProgram({ iteration_label: 'Cycle' }) });
    renderPage();

    await user.type(screen.getByLabelText('Program name'), '!');
    await act(async () => {
      await useSettingsSaveStore.getState().triggerSave();
    });
    const saved = mutateAsync.mock.calls.at(-1)?.[0] as {
      patch: { iteration_label: string | null };
    };
    expect(saved.patch.iteration_label).toBe('Cycle');
  });

  it('normalizes a whitespace-only iteration label back to inherit (ADR-0116)', async () => {
    const user = userEvent.setup();
    useProgram.mockReturnValue({ data: makeProgram({ iteration_label: '   ' }) });
    renderPage();

    await user.type(screen.getByLabelText('Program name'), '!');
    await act(async () => {
      await useSettingsSaveStore.getState().triggerSave();
    });
    const saved = mutateAsync.mock.calls.at(-1)?.[0] as {
      patch: { iteration_label: string | null };
    };
    // A blank override is "inherit", never an empty string the serializer rejects.
    expect(saved.patch.iteration_label).toBeNull();
  });

  // ----- Synchronous JSON seed export (#616) --------------------------------

  it('exports the program seed using the program code as the filename hint', async () => {
    const user = userEvent.setup();
    useProgram.mockReturnValue({ data: makeProgram() });
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Export to JSON' }));
    expect(seedMutate).toHaveBeenCalledWith({ programId: 'p-1', code: 'PH2' });
  });

  it('locks the seed export button while the download is being produced', () => {
    exportSeedState.isPending = true;
    useProgram.mockReturnValue({ data: makeProgram() });
    renderPage();
    expect(screen.getByRole('button', { name: 'Exporting…' })).toBeDisabled();
  });

  it('surfaces a failed seed export', () => {
    exportSeedState.isError = true;
    useProgram.mockReturnValue({ data: makeProgram() });
    renderPage();
    expect(screen.getByRole('alert')).toHaveTextContent('Export failed — please try again.');
  });

  // ----- Async export bundle (#1958) ----------------------------------------

  it('queues an export bundle and reports build progress', async () => {
    const user = userEvent.setup();
    jobState.data = makeJob({ status: 'running' });
    useProgram.mockReturnValue({ data: makeProgram() });
    renderPage();

    await user.click(screen.getByRole('button', { name: /Export program bundle/ }));
    expect(startMutate).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Building bundle…')).toBeInTheDocument();
    // Busy → the control refuses a second queue request.
    expect(screen.getByRole('button', { name: 'Working…' })).toBeDisabled();
  });

  it('offers a download once the bundle is ready, and can rebuild it', async () => {
    const user = userEvent.setup();
    const readyJob = makeJob({ status: 'success', downloadUrl: '/media/exports/job-1.tar.gz' });
    jobState.data = readyJob;
    useProgram.mockReturnValue({ data: makeProgram() });
    renderPage();

    await user.click(screen.getByRole('button', { name: /Export program bundle/ }));
    const download = screen.getByRole('button', { name: 'Download bundle' });
    expect(download).toBeEnabled();

    await user.click(download);
    // Streamed through the authenticated client, named from the program code.
    expect(downloadMock).toHaveBeenCalledWith('p-1', readyJob, 'PH2');

    await user.click(screen.getByRole('button', { name: 'Rebuild' }));
    expect(startMutate).toHaveBeenCalledTimes(2);
  });

  it('tells the user to rebuild when an expired link fails to download', async () => {
    const user = userEvent.setup();
    downloadMock.mockRejectedValue(new Error('410 Gone'));
    jobState.data = makeJob({ status: 'success', downloadUrl: '/media/exports/job-1.tar.gz' });
    useProgram.mockReturnValue({ data: makeProgram() });
    renderPage();

    await user.click(screen.getByRole('button', { name: /Export program bundle/ }));
    await user.click(screen.getByRole('button', { name: 'Download bundle' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Download failed — the link may have expired. Build a new bundle.',
    );
  });

  it('does not offer a download until the archive URL is present', async () => {
    const user = userEvent.setup();
    // A success status with no URL is not downloadable — offering the button
    // would produce a dead click.
    jobState.data = makeJob({ status: 'success', downloadUrl: null });
    useProgram.mockReturnValue({ data: makeProgram() });
    renderPage();

    await user.click(screen.getByRole('button', { name: /Export program bundle/ }));
    expect(screen.queryByRole('button', { name: 'Download bundle' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rebuild' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Export program bundle/ })).toBeEnabled();
  });

  it('reports a failed build with the server-supplied detail', async () => {
    const user = userEvent.setup();
    jobState.data = makeJob({ status: 'failed', errorDetail: 'archive exceeded the size limit' });
    useProgram.mockReturnValue({ data: makeProgram() });
    renderPage();

    await user.click(screen.getByRole('button', { name: /Export program bundle/ }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Export failed: archive exceeded the size limit. Try again.',
    );
  });

  it('reports a failure to even queue the bundle', () => {
    startState.error = new Error('Export queue is unavailable');
    useProgram.mockReturnValue({ data: makeProgram() });
    renderPage();
    expect(screen.getByRole('alert')).toHaveTextContent('Export queue is unavailable');
  });
});
