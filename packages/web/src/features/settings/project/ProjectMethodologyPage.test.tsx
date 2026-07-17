import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProjectMethodologyPage } from './ProjectMethodologyPage';
import { useSettingsSaveStore } from '../hooks/useSettingsSaveStore';

const useProjectId = vi.fn();
const useProject = vi.fn();
const useUpdateProject = vi.fn();
const useCurrentUserRole = vi.fn();
const useWorkspaceSettings = vi.fn();
const mutateAsync = vi.fn();

vi.mock('@/hooks/useProjectId', () => ({
  useProjectId: () => useProjectId() as string | undefined,
}));
vi.mock('@/hooks/useProject', () => ({
  useProject: (id: string | undefined) => useProject(id) as { data: unknown },
}));
vi.mock('@/hooks/useProjectMutations', () => ({
  useUpdateProject: (id: string | undefined) =>
    useUpdateProject(id) as { mutateAsync: (p: unknown) => Promise<unknown> },
}));
vi.mock('@/hooks/useCurrentUserRole', () => ({
  useCurrentUserRole: () => useCurrentUserRole() as { role: number | null; isLoading: boolean },
}));
vi.mock('../hooks/useWorkspaceSettings', () => ({
  useWorkspaceSettings: () => useWorkspaceSettings() as { data: unknown },
}));

function makeProject(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p-1',
    methodology: 'AGILE',
    effective_methodology: 'AGILE',
    inherited_methodology: 'WATERFALL',
    estimation_mode: 'open',
    ...overrides,
  };
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ProjectMethodologyPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ProjectMethodologyPage', () => {
  beforeEach(() => {
    mutateAsync.mockReset();
    mutateAsync.mockResolvedValue(undefined);
    useProjectId.mockReturnValue('p-1');
    useUpdateProject.mockReturnValue({ mutateAsync });
    // Admin can edit; workspace allows overrides (SUGGEST).
    useCurrentUserRole.mockReturnValue({ role: 400, isLoading: false });
    useWorkspaceSettings.mockReturnValue({ data: { methodologyOverridePolicy: 'suggest' } });
    useProject.mockReturnValue({ data: makeProject() });
    useSettingsSaveStore.getState().reset();
  });

  it('seeds the picker from the project methodology and shows the inherited default', () => {
    renderPage();
    expect(screen.getByRole('radio', { name: /Agile/i, checked: true })).toBeInTheDocument();
    // The inherited (workspace/program) default is surfaced as context.
    expect(screen.getByText(/Inherited from the workspace default/i)).toBeInTheDocument();
  });

  it('saves the chosen override via PATCH for an Admin under SUGGEST', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('radio', { name: /Waterfall/i }));
    expect(useSettingsSaveStore.getState().dirty).toBe(true);

    await act(async () => {
      await useSettingsSaveStore.getState().triggerSave();
    });
    expect(mutateAsync).toHaveBeenCalledWith({ methodology: 'WATERFALL' });
  });

  it('locks the picker and shows the workspace value under an INHERIT policy', () => {
    useWorkspaceSettings.mockReturnValue({ data: { methodologyOverridePolicy: 'inherit' } });
    useProject.mockReturnValue({
      data: makeProject({ methodology: 'AGILE', effective_methodology: 'WATERFALL' }),
    });
    renderPage();

    expect(screen.getByText(/requires every project to use its default methodology/i)).toBeInTheDocument();
    // Locked: no interactive radios — the workspace-resolved value (Waterfall) shows read-only.
    expect(screen.queryByRole('radio')).toBeNull();
    expect(
      screen.getByLabelText('Methodology: Waterfall, locked by workspace policy. View only.'),
    ).toBeInTheDocument();
  });

  it('lets a Scheduler edit the picker — the API grants Scheduler+ (#2019)', async () => {
    // methodology is in the serializer's _SCHEDULER_WRITABLE_FIELDS, so the UI
    // must not gate stricter than the API (previously required Admin/300).
    const user = userEvent.setup();
    useCurrentUserRole.mockReturnValue({ role: 200, isLoading: false });
    renderPage();

    const waterfall = screen.getByRole('radio', { name: /Waterfall/i });
    expect(waterfall).toBeEnabled();
    await user.click(waterfall);
    expect(useSettingsSaveStore.getState().dirty).toBe(true);
    await act(async () => {
      await useSettingsSaveStore.getState().triggerSave();
    });
    expect(mutateAsync).toHaveBeenCalledWith({ methodology: 'WATERFALL' });
  });

  it('renders read-only for a sub-Scheduler role', () => {
    // A Member (100) is below Scheduler (200) and sees the effective value, not a picker.
    useCurrentUserRole.mockReturnValue({ role: 100, isLoading: false });
    renderPage();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(
      screen.getByLabelText('Methodology: Agile, managed by the project scheduler. View only.'),
    ).toBeInTheDocument();
  });

  // ── Estimate governance (#2018) ─────────────────────────────────────────
  it('seeds the estimate-governance select from the project (#2018)', () => {
    useProject.mockReturnValue({ data: makeProject({ estimation_mode: 'suggest_approve' }) });
    renderPage();
    expect(screen.getByRole('combobox', { name: 'Estimate governance' })).toHaveValue(
      'suggest_approve',
    );
  });

  it('saves ONLY estimation_mode when methodology is unchanged (#2018)', async () => {
    renderPage();
    fireEvent.change(screen.getByRole('combobox', { name: 'Estimate governance' }), {
      target: { value: 'pm_only' },
    });
    await act(async () => {
      await useSettingsSaveStore.getState().triggerSave();
    });
    // Methodology was not touched — the payload must not carry it (a locked
    // methodology would otherwise 403 the whole PATCH).
    expect(mutateAsync).toHaveBeenCalledWith({ estimation_mode: 'pm_only' });
  });

  it('keeps estimate governance editable under an INHERIT methodology lock (#2018)', async () => {
    // Methodology is locked by the workspace policy, but estimation is independent.
    useWorkspaceSettings.mockReturnValue({ data: { methodologyOverridePolicy: 'inherit' } });
    renderPage();

    // The methodology picker is locked…
    expect(screen.getByRole('radio', { name: /Agile/i })).toBeDisabled();
    // …but estimate governance is still editable and saves on its own.
    const select = screen.getByRole('combobox', { name: 'Estimate governance' });
    expect(select).toBeEnabled();
    fireEvent.change(select, { target: { value: 'pm_only' } });
    await act(async () => {
      await useSettingsSaveStore.getState().triggerSave();
    });
    expect(mutateAsync).toHaveBeenCalledWith({ estimation_mode: 'pm_only' });
  });

  it('disables estimate governance for a sub-Scheduler role (#2018)', () => {
    useCurrentUserRole.mockReturnValue({ role: 100, isLoading: false });
    renderPage();
    expect(screen.getByRole('combobox', { name: 'Estimate governance' })).toBeDisabled();
  });
});
