import { act, fireEvent, render, screen, within } from '@testing-library/react';
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
const useSprints = vi.fn();
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
// Existing sprints feed the flip-warning dialog (#2619). Default: none, so the
// existing save-flow tests below (predating #2619) keep saving immediately.
vi.mock('@/hooks/useSprints', () => ({
  useSprints: () =>
    useSprints() as {
      sprints: unknown[];
      isLoading: boolean;
      error: unknown;
      refetch: () => void;
    },
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
    useSprints.mockReturnValue({ sprints: [], isLoading: false, error: null, refetch: vi.fn() });
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

    expect(
      screen.getByText(/requires every project to use its default methodology/i),
    ).toBeInTheDocument();
    // Locked: no interactive methodology-option radios — the workspace-resolved value
    // (Waterfall) shows read-only. (The independent estimation-scale control below has
    // its own Inherit/Override radios; scope the assertion to the methodology cards.)
    expect(screen.queryByRole('radio', { name: /Waterfall|Agile|Hybrid/i })).toBeNull();
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

    // The methodology picker is locked read-only by workspace policy (ADR-0133):
    // no disabled radios — effective value + provenance instead. (Scope past the
    // estimation-scale control's own Inherit/Override radios.)
    expect(screen.queryByRole('radio', { name: /Waterfall|Agile|Hybrid/i })).toBeNull();
    expect(
      screen.getByLabelText('Methodology: Agile, locked by workspace policy. View only.'),
    ).toBeInTheDocument();
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

  // ── Flip-warning dialog (#2619) ──────────────────────────────────────────
  describe('flip to WATERFALL with existing sprints', () => {
    beforeEach(() => {
      useSprints.mockReturnValue({
        sprints: [{ id: 's1' }, { id: 's2' }],
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      });
    });

    it('blocks the save behind a confirm dialog naming the sprint count', async () => {
      const user = userEvent.setup();
      renderPage();

      await user.click(screen.getByRole('radio', { name: /Waterfall/i }));

      // Fire the save without awaiting it to completion — handleSave blocks on
      // the confirm dialog, which only resolves once the user answers it below.
      // `act` (sync form) flushes the dialog-opening state update that happens
      // synchronously before handleSave's first await; it does not wait for the
      // save itself to finish.
      let settled = false;
      let savePromise!: Promise<void>;
      act(() => {
        savePromise = useSettingsSaveStore
          .getState()
          .triggerSave()
          .then(() => {
            settled = true;
          });
      });

      const dialog = await screen.findByRole('alertdialog', { name: 'Switch to Waterfall?' });
      expect(within(dialog).getByText(/2 sprints already committed/)).toBeInTheDocument();
      expect(mutateAsync).not.toHaveBeenCalled();
      expect(settled).toBe(false);

      await user.click(within(dialog).getByRole('button', { name: 'Switch to Waterfall' }));
      await act(async () => {
        await savePromise;
      });

      expect(mutateAsync).toHaveBeenCalledWith({ methodology: 'WATERFALL' });
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });

    it('cancelling the dialog leaves the save undone and the form dirty', async () => {
      const user = userEvent.setup();
      renderPage();

      await user.click(screen.getByRole('radio', { name: /Waterfall/i }));

      let savePromise!: Promise<void>;
      act(() => {
        savePromise = useSettingsSaveStore.getState().triggerSave();
      });
      const dialog = await screen.findByRole('alertdialog', { name: 'Switch to Waterfall?' });
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await act(async () => {
        await savePromise;
      });

      expect(mutateAsync).not.toHaveBeenCalled();
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(useSettingsSaveStore.getState().dirty).toBe(true);
    });

    it('does not warn for a flip between AGILE and HYBRID (both show sprints)', async () => {
      const user = userEvent.setup();
      renderPage();

      await user.click(screen.getByRole('radio', { name: /Hybrid/i }));
      await act(async () => {
        await useSettingsSaveStore.getState().triggerSave();
      });

      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(mutateAsync).toHaveBeenCalledWith({ methodology: 'HYBRID' });
    });
  });
});
