import { act, render, screen, fireEvent, within } from '@testing-library/react';
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
  calendar: 'cal-1',
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
  attachments_enabled: null,
  allowed_attachment_types: null,
  effective_attachments_enabled: true,
  effective_allowed_attachment_types: ['application/pdf'],
  inherited_attachments_enabled: true,
  inherited_allowed_attachment_types: ['application/pdf'],
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

  it('clears calendar to null when the Inherit toggle is pressed', () => {
    renderPage();

    const inherit = screen.getByRole('button', { name: /inherit from workspace/i });
    // Seed has calendar set, so Inherit starts unpressed.
    expect(inherit).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(inherit);
    expect(inherit).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows a workaround hint for the still-stubbed calendar override (#668)', () => {
    renderPage();
    expect(
      screen.getByText(/Workaround: set the work week per task under Task . Calendar/i),
    ).toBeInTheDocument();
  });

  it('disables the calendar "+ Override" button with the #968 picker reference', () => {
    renderPage();
    const override = screen.getByRole('button', { name: '+ Override' });
    expect(override).toBeDisabled();
    expect(override).toHaveAttribute('title', expect.stringContaining('#968'));
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

    // Switch visibility WORKSPACE → PRIVATE.
    fireEvent.click(screen.getByText(/^private$/i));

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
        visibility: 'PRIVATE',
        timezone: 'Europe/London',
        default_view: 'TABLE',
        calendar: 'cal-1',
      }),
    );
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
});
