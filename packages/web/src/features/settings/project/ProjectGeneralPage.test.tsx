import { act, render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProjectGeneralPage } from './ProjectGeneralPage';
import { useSettingsSaveStore } from '../hooks/useSettingsSaveStore';

const useProjectId = vi.fn();
const useProject = vi.fn();
const useUpdateProject = vi.fn();
const useCurrentUserRole = vi.fn();

vi.mock('@/hooks/useProjectId', () => ({
  useProjectId: () => useProjectId() as string | undefined,
}));

vi.mock('@/hooks/useCurrentUserRole', () => ({
  useCurrentUserRole: () => useCurrentUserRole() as { role: number | null; isLoading: boolean },
}));

vi.mock('@/hooks/useProject', () => ({
  useProject: (projectId: string | undefined) => useProject(projectId) as { data: unknown },
}));

vi.mock('@/hooks/useProjectMutations', () => ({
  useUpdateProject: (projectId: string | undefined) =>
    useUpdateProject(projectId) as { mutateAsync: (payload: unknown) => Promise<unknown> },
}));

// The lead MemberPicker fetches the project roster; stub it so the test makes no
// network call. Picker interaction is covered by EntitySelectCombobox.test.tsx.
vi.mock('@/hooks/useProjectMembers', () => ({
  useProjectMembers: () => ({ members: [], isLoading: false }),
}));

// The move-to-program dialog (#2089) fetches the program list on open; stub it so
// no network call fires. The dialog's own picker logic is covered in
// MoveProgramDialog.test.tsx — here we only assert the row + open/confirm wiring.
const { programsState } = vi.hoisted(() => ({
  programsState: {
    current: {
      data: [{ id: 'prog-a', name: 'Apollo', my_role: 300, is_closed: false }] as unknown[],
      isLoading: false,
    },
  },
}));
vi.mock('@/hooks/usePrograms', () => ({
  usePrograms: () => programsState.current,
}));

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/projects/p-1/settings/general']}>
        <Routes>
          <Route path="/projects/:projectId/settings/general" element={<ProjectGeneralPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const SEED_PROJECT = {
  id: 'p-1',
  server_version: 1,
  name: 'Atlas Migration',
  description: 'Migrate the data warehouse to the new platform.',
  start_date: '2026-01-01',
  status_date: null,
  prioritization_model: 'wsjf',
  stale_task_threshold_days: 14,
  end_date_shift_threshold_days: 3,
  // Own base override set (calendar_source 'project'): the read-only summary names
  // the resolved calendar and tags it "Override" (ADR-0441, #2009).
  calendar: 'cal-1',
  calendar_source: 'project',
  effective_calendar: { id: 'cal-1', name: 'Standard 5-day', working_days: 31, hours_per_day: 8 },
  estimation_mode: 'open',
  agile_features: false,
  methodology: 'HYBRID',
  code: 'ATLAS',
  health: 'AT_RISK',
  visibility: 'WORKSPACE',
  timezone: 'Europe/London',
  default_view: 'BOARD',
  lead: null,
  lead_detail: null,
  // Forecast-history overrides start null (inheriting); the server resolves the
  // inherited_* reads the inherit affordance renders (ADR-0144, #1232).
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
  // Standalone by default (#2089); the program-move tests flip program_detail.
  program: null,
  program_detail: null,
};

let mutateAsync: ReturnType<typeof vi.fn>;

beforeEach(() => {
  useProjectId.mockReturnValue('p-1');
  useProject.mockReturnValue({ data: SEED_PROJECT });
  mutateAsync = vi.fn().mockResolvedValue(undefined);
  useUpdateProject.mockReturnValue({ mutateAsync });
  // Default to Admin so the existing editable-field expectations hold; the
  // read-only tests override this with a sub-Admin role (#1084).
  useCurrentUserRole.mockReturnValue({ role: 300, isLoading: false });
});

describe('ProjectGeneralPage', () => {
  it('seeds every extended field from the project record and keeps them editable', () => {
    renderPage();

    const name = screen.getByRole('textbox', { name: /project name/i });
    expect(name).toHaveValue('Atlas Migration');
    expect(name).not.toBeDisabled();

    const code = screen.getByRole('textbox', { name: /project code/i });
    expect(code).toHaveValue('ATLAS');
    expect(code).not.toBeDisabled();

    const description = screen.getByRole('textbox', { name: /description/i });
    expect(description).toHaveValue('Migrate the data warehouse to the new platform.');
    expect(description).not.toBeDisabled();

    // Health: the At-risk pill should be pressed (matches SEED.health = AT_RISK).
    const atRiskPill = screen.getByRole('button', { name: /at risk/i });
    expect(atRiskPill).toHaveAttribute('aria-pressed', 'true');
    expect(atRiskPill).not.toBeDisabled();

    // Timezone select carries the seeded value.
    const timezone = screen.getByRole('combobox', { name: /timezone/i });
    expect(timezone).toHaveValue('Europe/London');
    expect(timezone).not.toBeDisabled();

    // Default-view select carries the seeded value.
    const defaultView = screen.getByRole('combobox', { name: /default view/i });
    expect(defaultView).toHaveValue('BOARD');
    expect(defaultView).not.toBeDisabled();
  });

  it('renders the duration-change policy control inheriting the program/workspace default', () => {
    renderPage();
    const group = screen.getByRole('radiogroup', { name: 'Duration change percent policy' });
    expect(group).toBeInTheDocument();
    // Fixture override is null → inheriting; the inherited value ('keep') surfaces
    // via the "Inherit (Keep entered %)" chip.
    expect(within(group).getByText(/Keep entered %/)).toBeInTheDocument();
  });

  it('re-seeds the form when the project in the route changes (no remount)', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // A fresh element each call so React actually re-renders (an identical
    // element reference would bail out); the same queryClient + matching element
    // types preserve the ProjectGeneralPage instance, mirroring a route param
    // change without a remount.
    const tree = () => (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/projects/p-1/settings/general']}>
          <Routes>
            <Route path="/projects/:projectId/settings/general" element={<ProjectGeneralPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
    const { rerender } = render(tree());
    expect(screen.getByRole('textbox', { name: /project name/i })).toHaveValue('Atlas Migration');

    // Switch to a different project. react-router reuses this component across
    // :projectId changes (no remount), so the one-shot seed guard regression
    // (#750) would leave 'Atlas Migration' stranded here.
    useProjectId.mockReturnValue('p-2');
    useProject.mockReturnValue({
      data: { ...SEED_PROJECT, id: 'p-2', name: 'Beacon Rollout', code: 'BEACON' },
    });
    rerender(tree());

    expect(screen.getByRole('textbox', { name: /project name/i })).toHaveValue('Beacon Rollout');
    expect(screen.getByRole('textbox', { name: /project code/i })).toHaveValue('BEACON');
  });

  it('uppercases code input on the fly so server validation stays satisfied', () => {
    useProject.mockReturnValue({ data: { ...SEED_PROJECT, code: '' } });
    renderPage();

    const code = screen.getByRole('textbox', { name: /project code/i });
    fireEvent.change(code, { target: { value: 'eng-2026' } });
    expect(code).toHaveValue('ENG-2026');
  });

  // The working calendar is read-only here now (ADR-0441, #2009): the base FK +
  // holiday overlays are composed on the Working calendars sub-page, the single
  // write surface. This page shows a summary and links there — no picker, no toggle.
  // The "Override"/"Inherited" chip words also appear on the inheritable forecast
  // controls, so scope calendar assertions to the "Working calendar" FieldRow.
  function calendarRow() {
    return screen.getByText('Working calendar').closest('.grid') as HTMLElement;
  }

  it('renders the working calendar as a read-only summary with an override tag (#2009)', () => {
    renderPage();
    const row = within(calendarRow());
    // The resolved calendar name, tagged as the project's own override.
    expect(row.getByText('Standard 5-day')).toBeInTheDocument();
    expect(row.getByText('Override')).toBeInTheDocument();
    // No editable picker or inherit toggle survives on this page.
    expect(
      screen.queryByRole('combobox', { name: 'Working calendar override' }),
    ).not.toBeInTheDocument();
    expect(row.queryByRole('button', { name: /inherit from workspace/i })).not.toBeInTheDocument();
  });

  it('links to the Working calendars sub-page as the single write surface (#2009)', () => {
    renderPage();
    const link = within(calendarRow()).getByRole('link', { name: /manage in working calendars/i });
    expect(link).toHaveAttribute('href', '/projects/p-1/settings/calendars');
  });

  it('shows the inherited provenance breadcrumb when the project has no own override (#2009)', () => {
    useProject.mockReturnValue({
      data: {
        ...SEED_PROJECT,
        calendar: null,
        calendar_source: 'workspace',
        effective_calendar: { id: 'cal-ws', name: 'Workspace default', working_days: 31, hours_per_day: 8 },
      },
    });
    renderPage();
    const row = within(calendarRow());
    expect(row.getByText('Workspace default')).toBeInTheDocument();
    expect(row.getByText('Inherited')).toBeInTheDocument();
    expect(row.getByText(/Inherited from workspace \(Workspace default\)/i)).toBeInTheDocument();
  });

  it('wires the project-lead picker — an enabled trigger opens the member listbox (#966)', () => {
    renderPage();
    // SEED has no lead → the trigger reads "Assign" and is enabled, not a #966 stub.
    const trigger = screen.getByRole('button', { name: 'Assign' });
    expect(trigger).toBeEnabled();
    fireEvent.click(trigger);
    expect(screen.getByRole('listbox', { name: 'Select project lead' })).toBeInTheDocument();
  });

  it('persists every edited field through the save mutation', async () => {
    renderPage();

    // Switch health AT_RISK → ON_TRACK.
    fireEvent.click(screen.getByRole('button', { name: /on track/i }));

    // Visibility is intentionally NOT edited here — the control is disabled until
    // enforcement ships (#2011, TODO(#2066)), so the save carries the seed value.

    // Pick a different default view.
    fireEvent.change(screen.getByRole('combobox', { name: /default view/i }), {
      target: { value: 'TABLE' },
    });

    // Drive the save through the store directly — this mirrors what
    // SettingsShell does when the user clicks the save bar or hits ⌘S.
    await act(async () => {
      await useSettingsSaveStore.getState().triggerSave();
    });

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Atlas Migration',
        code: 'ATLAS',
        health: 'ON_TRACK',
        visibility: 'WORKSPACE',
        timezone: 'Europe/London',
        default_view: 'TABLE',
      }),
    );
    // The calendar FK is no longer written from the General page (ADR-0441, #2009).
    expect(mutateAsync.mock.calls[0][0]).not.toHaveProperty('calendar');
  });

  it('seeds and persists the scheduling, backlog, and threshold fields (#2018)', async () => {
    renderPage();

    // Seeded values from SEED_PROJECT.
    expect(screen.getByLabelText('Start date')).toHaveValue('2026-01-01');
    // status_date null → "Today (dynamic)" pressed, the fixed-date input empty.
    expect(screen.getByRole('button', { name: 'Today (dynamic)' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByLabelText('Fixed status date')).toHaveValue('');
    expect(screen.getByRole('combobox', { name: 'Backlog scoring model' })).toHaveValue('wsjf');
    expect(screen.getByLabelText('Stale-task nudge after')).toHaveValue(14);
    expect(screen.getByLabelText('Notify on end-date shift of')).toHaveValue(3);

    // Edit each field.
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-02-01' } });
    fireEvent.change(screen.getByLabelText('Fixed status date'), { target: { value: '2026-03-15' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Backlog scoring model' }), {
      target: { value: 'rice' },
    });
    fireEvent.change(screen.getByLabelText('Stale-task nudge after'), { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText('Notify on end-date shift of'), {
      target: { value: '7' },
    });

    await act(async () => {
      await useSettingsSaveStore.getState().triggerSave();
    });

    expect(mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        start_date: '2026-02-01',
        status_date: '2026-03-15',
        prioritization_model: 'rice',
        stale_task_threshold_days: 30,
        end_date_shift_threshold_days: 7,
      }),
    );
  });

  it('clamps thresholds to 1–365 and clears status_date back to null on "Today" (#2018)', async () => {
    renderPage();

    // Over-max input clamps to 365.
    fireEvent.change(screen.getByLabelText('Stale-task nudge after'), { target: { value: '999' } });
    expect(screen.getByLabelText('Stale-task nudge after')).toHaveValue(365);

    // Arm a fixed status date, then clear it back to Today (dynamic).
    fireEvent.change(screen.getByLabelText('Fixed status date'), { target: { value: '2026-03-15' } });
    expect(screen.getByRole('button', { name: 'Today (dynamic)' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Today (dynamic)' }));
    expect(screen.getByLabelText('Fixed status date')).toHaveValue('');

    await act(async () => {
      await useSettingsSaveStore.getState().triggerSave();
    });
    expect(mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ stale_task_threshold_days: 365, status_date: null }),
    );
  });

  it('renders the visibility control disabled with a "not yet enforced" note (#2011)', () => {
    renderPage();

    // Both visibility radios are disabled — the setting is stored but access is
    // membership-scoped for every project, so an editable control would give
    // false assurance until enforcement ships (TODO(#2066)).
    const radios = screen
      .getAllByRole('radio')
      .filter((el) => (el as HTMLInputElement).name === 'project-visibility');
    expect(radios).toHaveLength(2);
    radios.forEach((radio) => expect(radio).toBeDisabled());

    expect(
      screen.getByText(/access is currently membership-scoped for all projects/i),
    ).toBeInTheDocument();
  });

  it('resets the save store between renders so the next page mounts clean', () => {
    useSettingsSaveStore.getState().reset();
    expect(useSettingsSaveStore.getState().dirty).toBe(false);
  });

  // ----- Role gating (#1084) -------------------------------------------------

  it('renders every field read-only for a sub-Admin (Member) role', () => {
    useCurrentUserRole.mockReturnValue({ role: 100, isLoading: false });
    renderPage();

    expect(screen.getByRole('textbox', { name: /project name/i })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: /project code/i })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: /description/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /at risk/i })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: /timezone/i })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: /default view/i })).toBeDisabled();
    // The lead picker drops its trigger entirely (rule 156 read-only render).
    expect(screen.queryByRole('button', { name: 'Assign' })).not.toBeInTheDocument();
  });

  it('keeps the form editable for an Admin role', () => {
    useCurrentUserRole.mockReturnValue({ role: 300, isLoading: false });
    renderPage();

    expect(screen.getByRole('textbox', { name: /project name/i })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Assign' })).toBeEnabled();
  });

  it('gates pessimistically (read-only) while the role query is still loading', () => {
    useCurrentUserRole.mockReturnValue({ role: null, isLoading: true });
    renderPage();
    expect(screen.getByRole('textbox', { name: /project name/i })).toBeDisabled();
  });

  // ----- Forecast history (ADR-0144, #1232) ----------------------------------

  it('renders the Forecast history group inheriting the resolved workspace values', () => {
    renderPage();

    expect(
      screen.getByRole('heading', { name: /forecast history/i, level: 3 }),
    ).toBeInTheDocument();

    // Each inheritable control starts on "Inherit" and surfaces the inherited value.
    const enabledGroup = screen.getByRole('radiogroup', {
      name: /keep monte carlo run history/i,
    });
    // Each of the three forecast-history controls renders and starts on "Inherit"
    // (the project seeds all three overrides null → inheriting the resolved value).
    const capGroup = screen.getByRole('radiogroup', { name: /run history limit/i });
    const attrGroup = screen.getByRole('radiogroup', { name: /run attribution visible to/i });
    for (const group of [enabledGroup, capGroup, attrGroup]) {
      expect(within(group).getByRole('radio', { name: /inherit/i })).toBeChecked();
    }
    // The attribution inherit chip carries the resolved label from the parent scope.
    expect(within(attrGroup).getByText(/admins & owners/i)).toBeInTheDocument();
  });

  it('overrides the retention cap and clamps an out-of-range value before persisting', async () => {
    renderPage();

    // Switch the retention control to Override, then enter a too-large value.
    const capGroup = screen.getByRole('radiogroup', { name: /run history limit/i });
    fireEvent.click(within(capGroup).getByText(/^override$/i));

    const capInput = screen.getByRole('spinbutton', { name: /run history limit/i });
    fireEvent.change(capInput, { target: { value: '9999' } });
    // The UI clamps to the 500 hard cap immediately.
    expect(capInput).toHaveValue(500);

    await act(async () => {
      await useSettingsSaveStore.getState().triggerSave();
    });

    expect(mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ mc_history_retention_cap: 500 }),
    );
  });

  it('overrides the attribution audience and persists the chosen enum', async () => {
    renderPage();

    const attrGroup = screen.getByRole('radiogroup', {
      name: /run attribution visible to/i,
    });
    fireEvent.click(within(attrGroup).getByText(/^override$/i));

    fireEvent.change(screen.getByRole('combobox', { name: /run attribution visible to/i }), {
      target: { value: 'NONE' },
    });

    await act(async () => {
      await useSettingsSaveStore.getState().triggerSave();
    });

    expect(mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ mc_history_attribution_audience: 'NONE' }),
    );
  });

  it('keeps a forecast-history override null when left on Inherit', async () => {
    renderPage();

    // Make some unrelated edit so the save bar arms without touching forecast history.
    fireEvent.click(screen.getByRole('button', { name: /on track/i }));

    await act(async () => {
      await useSettingsSaveStore.getState().triggerSave();
    });

    expect(mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        mc_history_enabled: null,
        mc_history_retention_cap: null,
        mc_history_attribution_audience: null,
      }),
    );
  });

  describe('program move (#2089)', () => {
    it('renders the standalone state with an "Add to program" affordance', () => {
      renderPage();
      expect(screen.getByText('Standalone')).toBeInTheDocument();
      expect(screen.getByText('No program')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /add to program/i })).toBeInTheDocument();
    });

    it('names the current program with a Move affordance when assigned', () => {
      useProject.mockReturnValue({
        data: { ...SEED_PROJECT, program: 'prog-z', program_detail: { id: 'prog-z', name: 'Zephyr' } },
      });
      renderPage();
      expect(screen.getByText('Zephyr')).toBeInTheDocument();
      expect(screen.getByText('In program')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^move…$/i })).toBeInTheDocument();
    });

    it('disables the move affordance below Admin (#1084)', () => {
      useCurrentUserRole.mockReturnValue({ role: 100, isLoading: false });
      renderPage();
      expect(screen.getByRole('button', { name: /add to program/i })).toBeDisabled();
    });

    it('opens the picker and fires an isolated PATCH carrying only program', async () => {
      renderPage();
      fireEvent.click(screen.getByRole('button', { name: /add to program/i }));

      const dialog = screen.getByRole('dialog');
      expect(dialog).toBeInTheDocument();

      fireEvent.click(within(dialog).getByRole('radio', { name: /Apollo/ }));
      fireEvent.click(within(dialog).getByRole('button', { name: 'Move project' }));

      await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({ program: 'prog-a' }));
      // The move never rides the shared save bar — its payload is program-only.
      expect(mutateAsync.mock.calls[0][0]).not.toHaveProperty('name');
    });

    it('surfaces the server 400 verbatim without closing the dialog', async () => {
      const err = Object.assign(new Error('rejected'), {
        isAxiosError: true,
        response: {
          status: 400,
          data: { program: ['You need at least Project Manager role on ‘Apollo’ to add this project to it.'] },
        },
      });
      mutateAsync.mockRejectedValueOnce(err);
      renderPage();
      fireEvent.click(screen.getByRole('button', { name: /add to program/i }));

      const dialog = screen.getByRole('dialog');
      fireEvent.click(within(dialog).getByRole('radio', { name: /Apollo/ }));
      fireEvent.click(within(dialog).getByRole('button', { name: 'Move project' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(/Project Manager role on ‘Apollo’/);
      // Dialog stays open so the user can correct or cancel.
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
  });
});
