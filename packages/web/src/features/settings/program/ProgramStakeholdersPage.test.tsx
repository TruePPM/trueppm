import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProgramStakeholdersPage } from './ProgramStakeholdersPage';
import { ROLE_VIEWER } from '@/lib/roles';

const useProgram = vi.fn();
const useProgramExternalStakeholders = vi.fn();
const useProgramMentionReach = vi.fn();
const createMutate = vi.fn();
const updateMutate = vi.fn();
const updateReset = vi.fn();
const removeMutate = vi.fn();

vi.mock('@/hooks/useProgram', () => ({
  useProgram: () => useProgram() as { data: unknown },
}));

vi.mock('../hooks/useProgramMentionReach', () => ({
  useProgramMentionReach: (programId: string | undefined, canRead: boolean) =>
    useProgramMentionReach(programId, canRead) as { data: unknown; isPending: boolean },
}));

vi.mock('../hooks/useProgramExternalStakeholders', () => ({
  useProgramExternalStakeholders: () =>
    useProgramExternalStakeholders() as {
      data: unknown;
      isLoading: boolean;
      isError: boolean;
    },
  useProgramExternalStakeholderMutations: () => ({
    create: { mutate: createMutate, reset: vi.fn(), isPending: false, error: null },
    update: { mutate: updateMutate, reset: updateReset, isPending: false, error: null },
    remove: { mutate: removeMutate, reset: vi.fn(), isPending: false, error: null },
  }),
}));

const ADMIN = { id: 'p-1', name: 'Phase 2', my_role: 300 };
const VIEWER = { id: 'p-1', name: 'Phase 2', my_role: ROLE_VIEWER };

const STAKEHOLDER = {
  id: 's-1',
  name: 'Dana Client',
  email: 'dana@client.example',
  note: 'Sponsor',
  created_by: 'kelly',
};

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/programs/p-1/settings/stakeholders']}>
        <Routes>
          <Route
            path="/programs/:programId/settings/stakeholders"
            element={<ProgramStakeholdersPage />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ProgramStakeholdersPage (settings)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: reach resolved. Individual tests override for the degraded paths.
    useProgramMentionReach.mockReturnValue({
      data: {
        group_key: 'program-stakeholders',
        viewer_member_count: 6,
        external_stakeholder_count: 1,
      },
      isPending: false,
    });
  });

  it('renders the loading state', () => {
    useProgram.mockReturnValue({ data: ADMIN });
    useProgramExternalStakeholders.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    });
    renderPage();
    expect(screen.getByLabelText(/Loading external stakeholders/i)).toBeInTheDocument();
  });

  it('renders the error state', () => {
    useProgram.mockReturnValue({ data: ADMIN });
    useProgramExternalStakeholders.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    });
    renderPage();
    expect(screen.getByRole('alert')).toHaveTextContent(/Failed to load external stakeholders/i);
  });

  it('renders the empty state with an add hint for admins', () => {
    useProgram.mockReturnValue({ data: ADMIN });
    useProgramExternalStakeholders.mockReturnValue({ data: [], isLoading: false, isError: false });
    renderPage();
    expect(screen.getByText(/No external stakeholders yet/i)).toBeInTheDocument();
    expect(screen.getByText(/Add one below/i)).toBeInTheDocument();
  });

  it('renders stakeholder rows with a count and the add form for admins', () => {
    useProgram.mockReturnValue({ data: ADMIN });
    useProgramExternalStakeholders.mockReturnValue({
      data: [STAKEHOLDER],
      isLoading: false,
      isError: false,
    });
    renderPage();
    expect(screen.getByText('Dana Client')).toBeInTheDocument();
    expect(screen.getByText('dana@client.example')).toBeInTheDocument();
    expect(screen.getByRole('form', { name: /Add external stakeholder/i })).toBeInTheDocument();
  });

  // #2548: the header and read rows used to force a hard 5-column grid via an
  // inline `gridTemplateColumns` at every breakpoint, leaving Name + Email + Note
  // ~80px combined on a 375px viewport. Both now share one responsive Tailwind
  // ruler instead, and each stacked cell keeps its own label since the header
  // (the normal label source) hides below `md`.
  it('replaces the inline column style with a responsive grid and labels each stacked cell', () => {
    useProgram.mockReturnValue({ data: ADMIN });
    useProgramExternalStakeholders.mockReturnValue({
      data: [STAKEHOLDER],
      isLoading: false,
      isError: false,
    });
    const { container } = renderPage();

    const header = container.querySelector('[class*="rounded-t-card"]');
    expect(header).not.toBeNull();
    expect(header).not.toHaveAttribute('style');
    expect(header?.className).toContain('hidden');
    expect(header?.className).toContain('md:grid');
    expect(header?.className).toContain('grid-cols-1');
    expect(header?.className).toContain('md:grid-cols-[1.4fr_1.6fr_1.6fr_118px_116px]');

    // Unique to the read row in this render — the edit-row wrapper carries the
    // same border classes but only mounts while a row is being edited.
    const row = container.querySelector('[class*="last:border-b-0"]');
    expect(row).not.toBeNull();
    expect(row).not.toHaveAttribute('style');
    expect(row?.className).toContain('grid-cols-1');
    expect(row?.className).toContain('md:grid-cols-[1.4fr_1.6fr_1.6fr_118px_116px]');

    const rowScope = within(row as HTMLElement);
    expect(rowScope.getByText('Name')).toBeInTheDocument();
    expect(rowScope.getByText('Email')).toBeInTheDocument();
    expect(rowScope.getByText('Note')).toBeInTheDocument();
    expect(rowScope.getByText('Added by')).toBeInTheDocument();
  });

  it('hides the add form and remove controls for a viewer', () => {
    useProgram.mockReturnValue({ data: VIEWER });
    useProgramExternalStakeholders.mockReturnValue({
      data: [STAKEHOLDER],
      isLoading: false,
      isError: false,
    });
    renderPage();
    expect(screen.getByText('Dana Client')).toBeInTheDocument();
    expect(
      screen.queryByRole('form', { name: /Add external stakeholder/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remove Dana Client/i })).not.toBeInTheDocument();
    // #2530: edit is Admin+ only — a viewer gets no edit affordance at all.
    expect(screen.queryByRole('button', { name: /Edit Dana Client/i })).not.toBeInTheDocument();
  });

  it('submits the add form with the trimmed name + email', async () => {
    const user = userEvent.setup();
    useProgram.mockReturnValue({ data: ADMIN });
    useProgramExternalStakeholders.mockReturnValue({ data: [], isLoading: false, isError: false });
    renderPage();

    await user.type(screen.getByLabelText(/^Name/), '  Dana Client  ');
    await user.type(screen.getByLabelText(/^Email/), '  dana@client.example  ');
    await user.click(screen.getByRole('button', { name: /^Add$/ }));

    expect(createMutate).toHaveBeenCalledTimes(1);
    expect(createMutate.mock.calls[0][0]).toEqual({
      name: 'Dana Client',
      email: 'dana@client.example',
      note: undefined,
    });
  });

  it('renders the reach summary with both arms when rows exist (#2529)', () => {
    useProgram.mockReturnValue({ data: ADMIN });
    useProgramExternalStakeholders.mockReturnValue({
      data: [STAKEHOLDER],
      isLoading: false,
      isError: false,
    });
    renderPage();

    expect(screen.getByText(/1 external contact — listed only\./)).toBeInTheDocument();
    expect(document.body.textContent).toContain(
      '6 Viewer-role members get an in-app notification',
    );
  });

  it('wires the real Viewer count into the empty state (#2529)', () => {
    useProgram.mockReturnValue({ data: ADMIN });
    useProgramExternalStakeholders.mockReturnValue({ data: [], isLoading: false, isError: false });
    renderPage();

    expect(screen.getByRole('status')).toHaveTextContent(
      /No external stakeholders yet — @program-stakeholders reaches 6 Viewer-role members/i,
    );
  });

  it('falls back to the bare empty state when the reach read is unavailable', () => {
    useProgram.mockReturnValue({ data: ADMIN });
    useProgramMentionReach.mockReturnValue({ data: undefined, isPending: false });
    useProgramExternalStakeholders.mockReturnValue({ data: [], isLoading: false, isError: false });
    renderPage();

    // Never substitute a number for an unavailable count.
    expect(screen.getByRole('status')).toHaveTextContent(
      'No external stakeholders yet. Add one below.',
    );
    expect(document.body.textContent).not.toMatch(/Viewer-role/);
  });

  it('does not request the Admin-only reach read as a viewer, and says so (#2529)', () => {
    useProgram.mockReturnValue({ data: VIEWER });
    // Query disabled → pending forever; the strip must not be held hostage to it.
    useProgramMentionReach.mockReturnValue({ data: undefined, isPending: true });
    useProgramExternalStakeholders.mockReturnValue({
      data: [STAKEHOLDER],
      isLoading: false,
      isError: false,
    });
    renderPage();

    expect(useProgramMentionReach).toHaveBeenCalledWith('p-1', false);
    expect(document.body.textContent).toContain('Viewer-role reach is visible to program admins.');
  });

  it('holds the strip until the reach read settles, so it mounts in one commit', () => {
    useProgram.mockReturnValue({ data: ADMIN });
    useProgramMentionReach.mockReturnValue({ data: undefined, isPending: true });
    useProgramExternalStakeholders.mockReturnValue({
      data: [STAKEHOLDER],
      isLoading: false,
      isError: false,
    });
    renderPage();

    expect(document.body.textContent).not.toContain('external contact — listed only.');
  });

  it('requires a confirm click before removing a stakeholder', async () => {
    const user = userEvent.setup();
    useProgram.mockReturnValue({ data: ADMIN });
    useProgramExternalStakeholders.mockReturnValue({
      data: [STAKEHOLDER],
      isLoading: false,
      isError: false,
    });
    renderPage();

    await user.click(screen.getByRole('button', { name: /Remove Dana Client/i }));
    expect(removeMutate).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /^Confirm$/ }));
    expect(removeMutate).toHaveBeenCalledWith('s-1');
  });

  // #2530 — inline edit. The row swaps to the SAME StakeholderEditRow the add
  // row renders, so these also pin the shared component's contract.
  describe('inline edit', () => {
    function renderWithRow() {
      useProgram.mockReturnValue({ data: ADMIN });
      useProgramExternalStakeholders.mockReturnValue({
        data: [STAKEHOLDER],
        isLoading: false,
        isError: false,
      });
      renderPage();
    }

    it('edits a stakeholder and PATCHes the changed field', async () => {
      const user = userEvent.setup();
      renderWithRow();

      await user.click(screen.getByRole('button', { name: 'Edit Dana Client' }));
      const form = screen.getByRole('form', { name: 'Edit Dana Client' });
      const email = within(form).getByLabelText(/^Email/);
      await user.clear(email);
      await user.type(email, 'dana@newclient.example');
      await user.click(within(form).getByRole('button', { name: /^Save$/ }));

      expect(updateMutate).toHaveBeenCalledTimes(1);
      expect(updateMutate.mock.calls[0][0]).toEqual({
        id: 's-1',
        name: 'Dana Client',
        email: 'dana@newclient.example',
        note: 'Sponsor',
      });
    });

    it('cancels an edit without mutating and restores the read row', async () => {
      const user = userEvent.setup();
      renderWithRow();

      await user.click(screen.getByRole('button', { name: 'Edit Dana Client' }));
      const form = screen.getByRole('form', { name: 'Edit Dana Client' });
      await user.clear(within(form).getByLabelText(/^Name/));
      await user.type(within(form).getByLabelText(/^Name/), 'Typo McTypo');
      await user.click(within(form).getByRole('button', { name: /^Cancel$/ }));

      expect(updateMutate).not.toHaveBeenCalled();
      expect(screen.queryByRole('form', { name: 'Edit Dana Client' })).not.toBeInTheDocument();
      expect(screen.getByText('Dana Client')).toBeInTheDocument();
      expect(screen.queryByText('Typo McTypo')).not.toBeInTheDocument();
    });

    it('blocks Save on a malformed email and explains why', async () => {
      const user = userEvent.setup();
      renderWithRow();

      await user.click(screen.getByRole('button', { name: 'Edit Dana Client' }));
      const form = screen.getByRole('form', { name: 'Edit Dana Client' });
      const email = within(form).getByLabelText(/^Email/);
      await user.clear(email);
      await user.type(email, 'dana@@nope');

      // The hint is advisory: it waits for blur rather than shouting at a
      // half-typed address, but Save is inert from the first bad character.
      expect(within(form).queryByRole('alert')).not.toBeInTheDocument();
      await user.tab();

      expect(within(form).getByRole('button', { name: /^Save$/ })).toBeDisabled();
      expect(within(form).getByRole('alert')).toHaveTextContent(/Enter a valid email address/i);
      expect(email).toHaveAttribute('aria-invalid', 'true');

      // Enter must not commit the value the helper text is warning about (rule 225).
      await user.click(email);
      await user.keyboard('{Enter}');
      expect(updateMutate).not.toHaveBeenCalled();
    });

    it('leaves Save inert until something actually changed', async () => {
      const user = userEvent.setup();
      renderWithRow();

      await user.click(screen.getByRole('button', { name: 'Edit Dana Client' }));
      const form = screen.getByRole('form', { name: 'Edit Dana Client' });
      expect(within(form).getByRole('button', { name: /^Save$/ })).toBeDisabled();

      await user.type(within(form).getByLabelText(/^Note/), '!');
      expect(within(form).getByRole('button', { name: /^Save$/ })).toBeEnabled();
    });

    it('seats focus in the edit row and returns it to Edit on cancel', async () => {
      const user = userEvent.setup();
      renderWithRow();

      await user.click(screen.getByRole('button', { name: 'Edit Dana Client' }));
      const form = screen.getByRole('form', { name: 'Edit Dana Client' });
      expect(within(form).getByLabelText(/^Name/)).toHaveFocus();

      await user.click(within(form).getByRole('button', { name: /^Cancel$/ }));
      expect(screen.getByRole('button', { name: 'Edit Dana Client' })).toHaveFocus();
    });

    it('discards a dirty add row on Cancel without creating anything', async () => {
      const user = userEvent.setup();
      useProgram.mockReturnValue({ data: ADMIN });
      useProgramExternalStakeholders.mockReturnValue({
        data: [],
        isLoading: false,
        isError: false,
      });
      renderPage();

      const form = screen.getByRole('form', { name: /Add external stakeholder/i });
      await user.type(within(form).getByLabelText(/^Name/), 'Oops');
      await user.click(within(form).getByRole('button', { name: /^Cancel$/ }));

      expect(createMutate).not.toHaveBeenCalled();
      expect(within(form).getByLabelText(/^Name/)).toHaveValue('');
      // …and the Cancel affordance folds away again once nothing is staged.
      expect(within(form).queryByRole('button', { name: /^Cancel$/ })).not.toBeInTheDocument();
    });
  });
});
