import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProgramAccessPage } from './ProgramAccessPage';
import { ROLE_OWNER, ROLE_MEMBER, ROLE_SCHEDULER } from '@/lib/roles';
import type { ProgramMembership } from '@/api/types';

const useProgram = vi.fn();
const useCurrentUser = vi.fn();
const useProgramMembers = vi.fn();
const updateRole = vi.fn();
const removeMember = vi.fn();

vi.mock('@/hooks/useProgram', () => ({
  useProgram: () => useProgram() as { data: unknown },
}));

vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => useCurrentUser() as { user: { id: string } | null },
}));

vi.mock('@/features/programs/hooks/useProgramMembers', () => ({
  useProgramMembers: () => useProgramMembers() as { data: ProgramMembership[]; isLoading: boolean; isError: boolean },
}));

vi.mock('@/features/programs/hooks/useProgramMemberMutations', () => ({
  useUpdateProgramMemberRole: () => ({ mutate: updateRole, isPending: false }),
  useRemoveProgramMember: () => ({ mutate: removeMember, isPending: false }),
  useAddProgramMember: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}));

// The invite form pulls in a user-search hook + apiClient — stub it so this
// test stays scoped to the Access page's own permission and table behavior.
vi.mock('@/features/programs/members/ProgramInviteForm', () => ({
  ProgramInviteForm: () => <div data-testid="invite-form" />,
}));

function makeMembership(overrides: Partial<ProgramMembership> = {}): ProgramMembership {
  return {
    id: 'm-1',
    server_version: 1,
    program: 'p-1',
    user: 'u-1',
    user_detail: { id: 'u-1', username: 'anika.k', email: 'anika@example.com' },
    role: ROLE_OWNER,
    role_label: 'Project Admin',
    joined_at: '2026-01-01T00:00:00Z',
    role_changed_at: null,
    ...overrides,
  };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/programs/p-1/settings/access']}>
        <Routes>
          <Route path="/programs/:programId/settings/access" element={<ProgramAccessPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ProgramAccessPage (settings)', () => {
  beforeEach(() => {
    useProgram.mockReset();
    useCurrentUser.mockReset();
    useProgramMembers.mockReset();
    updateRole.mockReset();
    removeMember.mockReset();
    useCurrentUser.mockReturnValue({ user: { id: 'u-1' } });
  });

  it('renders members from the API and shows the member count', () => {
    useProgram.mockReturnValue({ data: { id: 'p-1', my_role: ROLE_OWNER } });
    useProgramMembers.mockReturnValue({
      data: [
        makeMembership({ id: 'm-1', user: 'u-1' }),
        makeMembership({
          id: 'm-2',
          user: 'u-2',
          user_detail: { id: 'u-2', username: 'james.t', email: 'james@example.com' },
          role: ROLE_SCHEDULER,
          role_label: 'Resource Manager',
        }),
      ],
      isLoading: false,
      isError: false,
    });
    renderPage();
    expect(screen.getByText('anika.k')).toBeInTheDocument();
    expect(screen.getByText('james.t')).toBeInTheDocument();
    expect(screen.getByText(/2 members/)).toBeInTheDocument();
  });

  it('shows the Add member button only for Owners', () => {
    useProgram.mockReturnValue({ data: { id: 'p-1', my_role: 300 } });
    useProgramMembers.mockReturnValue({ data: [], isLoading: false, isError: false });
    renderPage();
    expect(screen.queryByRole('button', { name: /Add member/i })).not.toBeInTheDocument();
  });

  it('renders the Add member toggle and invite form for Owners', async () => {
    const user = userEvent.setup();
    useProgram.mockReturnValue({ data: { id: 'p-1', my_role: ROLE_OWNER } });
    useProgramMembers.mockReturnValue({ data: [], isLoading: false, isError: false });
    renderPage();
    const toggle = screen.getByRole('button', { name: /Add member/i });
    expect(toggle).toBeInTheDocument();
    expect(screen.queryByTestId('invite-form')).not.toBeInTheDocument();
    await user.click(toggle);
    expect(screen.getByTestId('invite-form')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Cancel/i })).toBeInTheDocument();
  });

  it('changing a non-owner role calls updateRole with the new ordinal', async () => {
    const user = userEvent.setup();
    useProgram.mockReturnValue({ data: { id: 'p-1', my_role: ROLE_OWNER } });
    useProgramMembers.mockReturnValue({
      data: [
        makeMembership({ id: 'm-1', user: 'u-1' }),
        makeMembership({
          id: 'm-2',
          user: 'u-2',
          user_detail: { id: 'u-2', username: 'sofia.p', email: 'sofia@example.com' },
          role: ROLE_MEMBER,
          role_label: 'Team Member',
        }),
      ],
      isLoading: false,
      isError: false,
    });
    renderPage();
    // RolePicker renders a bare native <select> with an id but no <label>;
    // narrow via the id we wired in the page.
    const select = document.getElementById('program-access-role-m-2') as HTMLSelectElement;
    expect(select).not.toBeNull();
    await user.selectOptions(select, String(ROLE_SCHEDULER));
    expect(updateRole).toHaveBeenCalledWith({ membershipId: 'm-2', role: ROLE_SCHEDULER });
  });

  it('hides the role picker for the Owner row', () => {
    useProgram.mockReturnValue({ data: { id: 'p-1', my_role: ROLE_OWNER } });
    useProgramMembers.mockReturnValue({
      data: [makeMembership({ id: 'm-1', user: 'u-1', role: ROLE_OWNER })],
      isLoading: false,
      isError: false,
    });
    renderPage();
    // The dash placeholder appears in place of the role picker for the Owner row.
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('remove flow requires a confirm click before calling removeMember', async () => {
    const user = userEvent.setup();
    useProgram.mockReturnValue({ data: { id: 'p-1', my_role: ROLE_OWNER } });
    useProgramMembers.mockReturnValue({
      data: [
        makeMembership({ id: 'm-1', user: 'u-1' }),
        makeMembership({
          id: 'm-2',
          user: 'u-2',
          user_detail: { id: 'u-2', username: 'sofia.p', email: 'sofia@example.com' },
          role: ROLE_MEMBER,
          role_label: 'Team Member',
        }),
      ],
      isLoading: false,
      isError: false,
    });
    renderPage();
    await user.click(screen.getByRole('button', { name: /Remove sofia.p/i }));
    expect(removeMember).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /^Confirm$/ }));
    expect(removeMember).toHaveBeenCalledWith('m-2');
  });

  it('shows the sole-owner guard when the only Owner is self', () => {
    useProgram.mockReturnValue({ data: { id: 'p-1', my_role: ROLE_OWNER } });
    useProgramMembers.mockReturnValue({
      data: [makeMembership({ id: 'm-1', user: 'u-1', role: ROLE_OWNER })],
      isLoading: false,
      isError: false,
    });
    renderPage();
    expect(screen.getByText(/Sole owner/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Leave/i })).not.toBeInTheDocument();
  });

  it('Member-role caller sees role labels but no role picker or remove button', () => {
    useProgram.mockReturnValue({ data: { id: 'p-1', my_role: ROLE_MEMBER } });
    useProgramMembers.mockReturnValue({
      data: [
        makeMembership({
          id: 'm-2',
          user: 'u-2',
          user_detail: { id: 'u-2', username: 'sofia.p', email: 'sofia@example.com' },
          role: ROLE_MEMBER,
          role_label: 'Team Member',
        }),
      ],
      isLoading: false,
      isError: false,
    });
    renderPage();
    expect(screen.getByText('Team Member')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remove/i })).not.toBeInTheDocument();
  });

  it('renders the error state when the members query fails', () => {
    useProgram.mockReturnValue({ data: { id: 'p-1', my_role: ROLE_OWNER } });
    useProgramMembers.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    renderPage();
    expect(screen.getByRole('alert')).toHaveTextContent(/Failed to load members/i);
  });

  it('renders the empty state when there are no members', () => {
    useProgram.mockReturnValue({ data: { id: 'p-1', my_role: ROLE_OWNER } });
    useProgramMembers.mockReturnValue({ data: [], isLoading: false, isError: false });
    renderPage();
    expect(screen.getByText(/No members yet/i)).toBeInTheDocument();
  });

  it('does not render the StubPageBanner once wired', () => {
    useProgram.mockReturnValue({ data: { id: 'p-1', my_role: ROLE_OWNER } });
    useProgramMembers.mockReturnValue({ data: [], isLoading: false, isError: false });
    renderPage();
    expect(screen.queryByTestId('stub-page-banner')).not.toBeInTheDocument();
  });
});
