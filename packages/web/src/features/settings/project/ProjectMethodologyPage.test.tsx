import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
const useMethodologyFlipImpact = vi.fn();
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
      totalCount: number;
      isLoading: boolean;
      error: unknown;
      refetch: () => void;
    },
}));
// The other three counts a flip can hide (#3294). Default: all zero and settled,
// so every test that predates it keeps the WATERFALL-with-sprints behaviour it
// was written for and no Agile flip warns.
vi.mock('./useMethodologyFlipImpact', () => ({
  useMethodologyFlipImpact: (id: string | undefined, enabled: boolean) =>
    useMethodologyFlipImpact(id, enabled) as {
      backlogCount: number | null;
      taskCount: number | null;
      dependencyCount: number | null;
      isLoading: boolean;
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
  // A FRESH element each call — React bails out of a re-render when handed the
  // identical element reference, which would leave the mocked hooks unread.
  const tree = () => (
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ProjectMethodologyPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
  const utils = render(tree());
  // Re-render in place so a test can move a mocked query from loading to
  // settled without remounting the page (which would lose its local state).
  return { ...utils, rerenderSame: () => utils.rerender(tree()) };
}

describe('ProjectMethodologyPage', () => {
  beforeEach(() => {
    mutateAsync.mockReset();
    useMethodologyFlipImpact.mockReset();
    mutateAsync.mockResolvedValue(undefined);
    useProjectId.mockReturnValue('p-1');
    useUpdateProject.mockReturnValue({ mutateAsync });
    // Admin can edit; workspace allows overrides (SUGGEST).
    useCurrentUserRole.mockReturnValue({ role: 400, isLoading: false });
    useWorkspaceSettings.mockReturnValue({ data: { methodologyOverridePolicy: 'suggest' } });
    useProject.mockReturnValue({ data: makeProject() });
    useSprints.mockReturnValue({
      sprints: [],
      totalCount: 0,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    useMethodologyFlipImpact.mockReturnValue({
      backlogCount: 0,
      taskCount: 0,
      dependencyCount: 0,
      isLoading: false,
    });
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
        totalCount: 2,
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

    // #3298. The dialog has always accepted a `pending` prop and rendered a
    // `Switching…` state from it, but the call site hard-coded `pending={false}`
    // AND unmounted the dialog inside `onConfirm` — so the state was unreachable
    // by construction and a slow PATCH showed an enabled button and no progress.
    it('holds the dialog open in its pending state while the PATCH is in flight', async () => {
      const user = userEvent.setup();
      let releasePatch!: () => void;
      mutateAsync.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            releasePatch = () => resolve();
          }),
      );
      renderPage();

      await user.click(screen.getByRole('radio', { name: /Waterfall/i }));

      let savePromise!: Promise<void>;
      act(() => {
        savePromise = useSettingsSaveStore.getState().triggerSave();
      });

      const dialog = await screen.findByRole('alertdialog', { name: 'Switch to Waterfall?' });
      const confirm = within(dialog).getByRole('button', { name: 'Switch to Waterfall' });
      expect(confirm).toBeEnabled();
      await user.click(confirm);

      // Still mounted, now showing progress, with both controls disabled so the
      // flip cannot be re-fired or abandoned mid-write.
      await waitFor(() => {
        const pendingDialog = screen.getByRole('alertdialog', { name: 'Switch to Waterfall?' });
        expect(within(pendingDialog).getByRole('button', { name: 'Switching…' })).toBeDisabled();
        expect(within(pendingDialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
      });
      expect(mutateAsync).toHaveBeenCalledWith({ methodology: 'WATERFALL' });

      await act(async () => {
        releasePatch();
        await savePromise;
      });
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });

    it('dismisses the dialog when the PATCH fails, rather than stranding it', async () => {
      const user = userEvent.setup();
      mutateAsync.mockRejectedValue(new Error('boom'));
      renderPage();

      await user.click(screen.getByRole('radio', { name: /Waterfall/i }));

      let savePromise!: Promise<void>;
      act(() => {
        savePromise = useSettingsSaveStore.getState().triggerSave();
      });
      const dialog = await screen.findByRole('alertdialog', { name: 'Switch to Waterfall?' });
      await user.click(within(dialog).getByRole('button', { name: 'Switch to Waterfall' }));
      await act(async () => {
        await savePromise;
      });

      // Closed by `handleSave`'s finally — a stranded pending dialog would trap
      // the user behind a focus trap with every control disabled.
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(useSettingsSaveStore.getState().saveError).toBe('boom');
      // The flip did not take, so the form stays dirty and the save bar armed.
      expect(useSettingsSaveStore.getState().dirty).toBe(true);
    });
  });

  // ── #3313: the trigger failing on its own terms ──────────────────────────
  // Distinct from #2619 (which surfaces the dialog) and #3294 (which surfaces
  // *more* things it should consider): these are cases where the existing
  // predicate evaluates against a count it does not yet, or cannot, know.
  describe('the sprints read has not resolved', () => {
    it('cannot save a Waterfall flip while the sprints query is still loading', async () => {
      const user = userEvent.setup();
      useSprints.mockReturnValue({
        sprints: [],
        totalCount: 0,
        isLoading: true,
        error: null,
        refetch: vi.fn(),
      });
      renderPage();

      await user.click(screen.getByRole('radio', { name: /Waterfall/i }));

      // The harm: with the save live before the count is known, a flip saved in
      // that window evaluates the trigger against a not-yet-known 0, skips the
      // consent dialog, and PATCHes — on timing alone, on a project that does
      // have sprints. `apiReady: false` keeps the section out of the store's
      // dirty set, so `triggerSave` cannot reach `handleSave` at all.
      expect(useSettingsSaveStore.getState().dirty).toBe(false);
      await act(async () => {
        await useSettingsSaveStore.getState().triggerSave();
      });
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(mutateAsync).not.toHaveBeenCalled();
    });

    it('arms the save once the sprints query settles, and then warns', async () => {
      const user = userEvent.setup();
      useSprints.mockReturnValue({
        sprints: [],
        totalCount: 0,
        isLoading: true,
        error: null,
        refetch: vi.fn(),
      });
      const { rerenderSame } = renderPage();

      await user.click(screen.getByRole('radio', { name: /Waterfall/i }));
      expect(useSettingsSaveStore.getState().dirty).toBe(false);

      // The query lands: 4 sprints. The pending selection survives, the bar arms,
      // and the save now evaluates the trigger against a count that exists.
      useSprints.mockReturnValue({
        sprints: [{ id: 's1' }],
        totalCount: 4,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      });
      act(() => {
        rerenderSame();
      });
      await waitFor(() => expect(useSettingsSaveStore.getState().dirty).toBe(true));

      act(() => {
        void useSettingsSaveStore.getState().triggerSave();
      });
      const dialog = await screen.findByRole('alertdialog', { name: 'Switch to Waterfall?' });
      expect(within(dialog).getByText(/has 4 sprints already committed/)).toBeInTheDocument();
      expect(mutateAsync).not.toHaveBeenCalled();
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    });

    it('warns on a Waterfall flip when the sprints read failed, rather than reading 0 as none', async () => {
      const user = userEvent.setup();
      useSprints.mockReturnValue({
        sprints: [],
        totalCount: 0,
        isLoading: false,
        error: new Error('boom'),
        refetch: vi.fn(),
      });
      renderPage();

      await user.click(screen.getByRole('radio', { name: /Waterfall/i }));

      let savePromise!: Promise<void>;
      act(() => {
        savePromise = useSettingsSaveStore.getState().triggerSave();
      });

      // A failed read is "cannot rule out sprints", so the consent gate still
      // arms — and says the total is unknown instead of claiming zero.
      const dialog = await screen.findByRole('alertdialog', { name: 'Switch to Waterfall?' });
      expect(within(dialog).getByText(/may have sprints already committed/)).toBeInTheDocument();
      expect(within(dialog).queryByText(/has 0 sprints already committed/)).toBeNull();
      expect(mutateAsync).not.toHaveBeenCalled();

      await user.click(within(dialog).getByRole('button', { name: 'Switch to Waterfall' }));
      await act(async () => {
        await savePromise;
      });
      expect(mutateAsync).toHaveBeenCalledWith({ methodology: 'WATERFALL' });
    });

    it("names the server's total in the dialog, not the length of the loaded page", async () => {
      const user = userEvent.setup();
      useSprints.mockReturnValue({
        // Page 1 carries two rows; the project has 37 sprints in total.
        sprints: [{ id: 's1' }, { id: 's2' }],
        totalCount: 37,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      });
      renderPage();

      await user.click(screen.getByRole('radio', { name: /Waterfall/i }));
      act(() => {
        void useSettingsSaveStore.getState().triggerSave();
      });

      const dialog = await screen.findByRole('alertdialog', { name: 'Switch to Waterfall?' });
      expect(within(dialog).getByText(/has 37 sprints already committed/)).toBeInTheDocument();

      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    });
  });

  // ── #3294: the trigger considered one of the four hidden views ───────────
  // WATERFALL hides `sprints` AND `product-backlog`; AGILE hides `schedule` AND
  // `calendar` (methodologyTabs.ts). #2619 wired only the first of those four,
  // so a groomed-but-sprintless project flipped to Waterfall in silence and a
  // flip to Agile warned about nothing at all.
  describe('every view the flip hides', () => {
    it('warns on a Waterfall flip with a groomed backlog and zero sprints', async () => {
      const user = userEvent.setup();
      // Zero sprints — the #2619 trigger finds nothing here and saves silently.
      useMethodologyFlipImpact.mockReturnValue({
        backlogCount: 180,
        taskCount: 0,
        dependencyCount: 0,
        isLoading: false,
      });
      renderPage();

      await user.click(screen.getByRole('radio', { name: /Waterfall/i }));
      let savePromise!: Promise<void>;
      act(() => {
        savePromise = useSettingsSaveStore.getState().triggerSave();
      });

      const dialog = await screen.findByRole('alertdialog', { name: 'Switch to Waterfall?' });
      expect(within(dialog).getByText(/180 items in the product backlog/)).toBeInTheDocument();
      // No sprints exist, so the dialog must not invent a sprint clause.
      expect(within(dialog).queryByText(/sprints already committed/)).toBeNull();
      expect(mutateAsync).not.toHaveBeenCalled();

      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await act(async () => {
        await savePromise;
      });
      // Cancel leaves the flip unsaved and the form dirty, on this branch too.
      expect(mutateAsync).not.toHaveBeenCalled();
      expect(useSettingsSaveStore.getState().dirty).toBe(true);
    });

    it('names both counts on a Waterfall flip with sprints and a backlog', async () => {
      const user = userEvent.setup();
      useSprints.mockReturnValue({
        sprints: [{ id: 's1' }],
        totalCount: 3,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      });
      useMethodologyFlipImpact.mockReturnValue({
        backlogCount: 42,
        taskCount: 0,
        dependencyCount: 0,
        isLoading: false,
      });
      renderPage();

      await user.click(screen.getByRole('radio', { name: /Waterfall/i }));
      act(() => {
        void useSettingsSaveStore.getState().triggerSave();
      });

      const dialog = await screen.findByRole('alertdialog', { name: 'Switch to Waterfall?' });
      expect(
        within(dialog).getByText(
          /has 3 sprints already committed and 42 items in the product backlog/,
        ),
      ).toBeInTheDocument();
      // And it names both views it is about to take away, from the one matrix.
      expect(within(dialog).getByText(/hides the Sprints and Backlog views/)).toBeInTheDocument();

      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    });

    it('warns on an Agile flip and names Schedule and Calendar', async () => {
      const user = userEvent.setup();
      useProject.mockReturnValue({
        data: makeProject({ methodology: 'WATERFALL', effective_methodology: 'WATERFALL' }),
      });
      useMethodologyFlipImpact.mockReturnValue({
        backlogCount: 0,
        taskCount: 64,
        dependencyCount: 17,
        isLoading: false,
      });
      renderPage();

      await user.click(screen.getByRole('radio', { name: /Agile/i }));
      let savePromise!: Promise<void>;
      act(() => {
        savePromise = useSettingsSaveStore.getState().triggerSave();
      });

      const dialog = await screen.findByRole('alertdialog', { name: 'Switch to Agile?' });
      expect(
        within(dialog).getByText(/has 64 tasks on the schedule and 17 dependency links/),
      ).toBeInTheDocument();
      expect(
        within(dialog).getByText(/Agile hides the Schedule and Calendar views/),
      ).toBeInTheDocument();
      expect(mutateAsync).not.toHaveBeenCalled();

      // Cancel leaves the form dirty and unsaved on the new branch too.
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await act(async () => {
        await savePromise;
      });
      expect(mutateAsync).not.toHaveBeenCalled();
      expect(useSettingsSaveStore.getState().dirty).toBe(true);
    });

    it('warns on a Hybrid → Agile flip — a Hybrid project plans on the Gantt', async () => {
      const user = userEvent.setup();
      useProject.mockReturnValue({
        data: makeProject({ methodology: 'HYBRID', effective_methodology: 'HYBRID' }),
      });
      useMethodologyFlipImpact.mockReturnValue({
        backlogCount: 0,
        taskCount: 8,
        dependencyCount: 0,
        isLoading: false,
      });
      renderPage();

      await user.click(screen.getByRole('radio', { name: /Agile/i }));
      act(() => {
        void useSettingsSaveStore.getState().triggerSave();
      });

      const dialog = await screen.findByRole('alertdialog', { name: 'Switch to Agile?' });
      // No dependencies exist, so only the task clause appears.
      expect(within(dialog).getByText(/has 8 tasks on the schedule\./)).toBeInTheDocument();
      expect(within(dialog).queryByText(/dependency links/)).toBeNull();

      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    });

    it('still does not warn on Agile → Hybrid — Hybrid hides nothing', async () => {
      const user = userEvent.setup();
      useSprints.mockReturnValue({
        sprints: [{ id: 's1' }],
        totalCount: 9,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      });
      useMethodologyFlipImpact.mockReturnValue({
        backlogCount: 120,
        taskCount: 400,
        dependencyCount: 90,
        isLoading: false,
      });
      renderPage();

      await user.click(screen.getByRole('radio', { name: /Hybrid/i }));
      await act(async () => {
        await useSettingsSaveStore.getState().triggerSave();
      });

      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(mutateAsync).toHaveBeenCalledWith({ methodology: 'HYBRID' });
    });

    it('does not warn on a Waterfall flip when there is nothing to hide', async () => {
      const user = userEvent.setup();
      useMethodologyFlipImpact.mockReturnValue({
        backlogCount: 0,
        taskCount: 500,
        dependencyCount: 300,
        isLoading: false,
      });
      renderPage();

      // Tasks and dependencies are what AGILE hides, not WATERFALL — they must
      // not leak into the other direction's trigger.
      await user.click(screen.getByRole('radio', { name: /Waterfall/i }));
      await act(async () => {
        await useSettingsSaveStore.getState().triggerSave();
      });

      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(mutateAsync).toHaveBeenCalledWith({ methodology: 'WATERFALL' });
    });

    it('does not read the counts until a methodology change is pending', async () => {
      const user = userEvent.setup();
      renderPage();

      // The consolidated settings page mounts every section at once, so an
      // unconditional read fires three counts on every project settings route.
      expect(useMethodologyFlipImpact).toHaveBeenCalled();
      expect(
        useMethodologyFlipImpact.mock.calls.every(([, enabled]) => enabled === false),
      ).toBe(true);

      await user.click(screen.getByRole('radio', { name: /Waterfall/i }));
      expect(useMethodologyFlipImpact).toHaveBeenLastCalledWith('p-1', true);

      // And it goes idle again when the pending flip is reverted.
      await user.click(screen.getByRole('radio', { name: /Agile/i }));
      expect(useMethodologyFlipImpact).toHaveBeenLastCalledWith('p-1', false);
    });

    it('cannot save while the flip-impact counts are still loading', async () => {
      const user = userEvent.setup();
      useMethodologyFlipImpact.mockReturnValue({
        backlogCount: 0,
        taskCount: 0,
        dependencyCount: 0,
        isLoading: true,
      });
      renderPage();

      await user.click(screen.getByRole('radio', { name: /Waterfall/i }));

      // Same #3313 hazard, one query wider: an unsettled count reads as 0 inside
      // handleSave, so a save landing in this window skips the gate on timing.
      expect(useSettingsSaveStore.getState().dirty).toBe(false);
      await act(async () => {
        await useSettingsSaveStore.getState().triggerSave();
      });
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(mutateAsync).not.toHaveBeenCalled();
    });

    it('warns when the backlog read failed, rather than reading 0 as none', async () => {
      const user = userEvent.setup();
      useMethodologyFlipImpact.mockReturnValue({
        backlogCount: null,
        taskCount: 0,
        dependencyCount: 0,
        isLoading: false,
      });
      renderPage();

      await user.click(screen.getByRole('radio', { name: /Waterfall/i }));
      act(() => {
        void useSettingsSaveStore.getState().triggerSave();
      });

      const dialog = await screen.findByRole('alertdialog', { name: 'Switch to Waterfall?' });
      expect(
        within(dialog).getByText(/may have items in the product backlog/),
      ).toBeInTheDocument();
      expect(mutateAsync).not.toHaveBeenCalled();

      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    });
  });

  // #3298. Both reads gate the skeleton, so either failing used to strand the page
  // on pulsing placeholders with no error and no retry (rule 246).
  describe('when a read fails', () => {
    it('renders the query-error state when the project GET fails', async () => {
      const user = userEvent.setup();
      const refetch = vi.fn();
      useProject.mockReturnValue({
        data: undefined,
        isLoading: false,
        isError: true,
        refetch,
      });
      renderPage();

      const failure = screen.getByRole('status');
      expect(failure).toHaveTextContent("Couldn't load this project's methodology.");
      expect(document.querySelectorAll('[class*="animate-pulse"]')).toHaveLength(0);
      expect(screen.getByRole('heading', { name: 'Methodology' })).toBeInTheDocument();

      await user.click(within(failure).getByRole('button', { name: 'Retry' }));
      expect(refetch).toHaveBeenCalledTimes(1);
    });

    it('renders the query-error state when the workspace GET fails', async () => {
      const user = userEvent.setup();
      const refetchWs = vi.fn();
      const refetchProject = vi.fn();
      useProject.mockReturnValue({
        data: makeProject(),
        isLoading: false,
        isError: false,
        refetch: refetchProject,
      });
      useWorkspaceSettings.mockReturnValue({
        data: undefined,
        isError: true,
        refetch: refetchWs,
      });
      renderPage();

      const failure = screen.getByRole('status');
      expect(failure).toHaveTextContent("Couldn't load this project's methodology.");
      // `ws === undefined` gates the skeleton too — without this branch the page
      // pulses forever even though the project itself loaded fine.
      expect(document.querySelectorAll('[class*="animate-pulse"]')).toHaveLength(0);

      // Retry re-runs only the request that actually failed.
      await user.click(within(failure).getByRole('button', { name: 'Retry' }));
      expect(refetchWs).toHaveBeenCalledTimes(1);
      expect(refetchProject).not.toHaveBeenCalled();
    });
  });
});
