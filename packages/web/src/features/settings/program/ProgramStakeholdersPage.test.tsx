import { render, screen } from '@testing-library/react';
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
    create: { mutate: createMutate, isPending: false, error: null },
    remove: { mutate: removeMutate, isPending: false, error: null },
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

  it('hides the add form and remove controls for a viewer', () => {
    useProgram.mockReturnValue({ data: VIEWER });
    useProgramExternalStakeholders.mockReturnValue({
      data: [STAKEHOLDER],
      isLoading: false,
      isError: false,
    });
    renderPage();
    expect(screen.getByText('Dana Client')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: /Add external stakeholder/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remove Dana Client/i })).not.toBeInTheDocument();
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
});
