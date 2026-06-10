import { screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { ProjectTeamPage } from './ProjectTeamPage';
import type { TeamMember } from './useTeam';

const mockMutate = vi.fn();

vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => 'proj-1' }));
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: { id: 'u-admin', username: 'alice' }, isLoading: false }),
}));

// Role is overridden per-test via this mutable holder.
const roleHolder = { role: 300 as number | null };
vi.mock('@/hooks/useCurrentUserRole', () => ({
  useCurrentUserRole: () => ({ role: roleHolder.role, isLoading: false }),
}));

const member = (over: Partial<TeamMember> = {}): TeamMember => ({
  id: 'tm-1',
  user: 'u-1',
  user_detail: { id: 'u-1', username: 'bob', email: 'bob@example.com' },
  role: 'member',
  role_label: 'Member',
  is_scrum_master: false,
  is_product_owner: false,
  ...over,
});

const membersHolder = { data: [] as TeamMember[] };

vi.mock('./useTeam', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./useTeam')>();
  return {
    ...actual,
    useDefaultTeam: () => ({
      data: { id: 'team-1', is_default: true },
      isLoading: false,
      isError: false,
    }),
    useTeamMembers: () => ({ data: membersHolder.data, isLoading: false, isError: false }),
    useUpdateTeamMember: () => ({
      mutate: mockMutate,
      isPending: false,
      variables: undefined,
      isError: false,
    }),
  };
});

beforeEach(() => {
  mockMutate.mockClear();
  roleHolder.role = 300;
  membersHolder.data = [
    member({
      id: 'tm-admin',
      user_detail: { id: 'u-admin', username: 'alice', email: 'a@x.com' },
      role: 'admin',
      role_label: 'Admin',
    }),
    member(),
  ];
});

describe('ProjectTeamPage', () => {
  it('renders the roster with facet switches', () => {
    renderWithRouter(<ProjectTeamPage />);
    expect(screen.getByText('bob')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Scrum Master: bob' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Product Owner: bob' })).toBeInTheDocument();
  });

  it('labels the facet columns with headers so each toggle is unambiguous (#974)', () => {
    renderWithRouter(<ProjectTeamPage />);
    const headers = within(screen.getByTestId('team-columns'));
    expect(headers.getByText('Scrum Master')).toBeInTheDocument();
    expect(headers.getByText('Product Owner')).toBeInTheDocument();
    expect(headers.getByText('Role')).toBeInTheDocument();
  });

  it('assigns a facet directly when no one else holds it', async () => {
    const user = userEvent.setup();
    renderWithRouter(<ProjectTeamPage />);
    await user.click(screen.getByRole('switch', { name: 'Scrum Master: bob' }));
    expect(mockMutate).toHaveBeenCalledWith({
      membershipId: 'tm-1',
      changes: { is_scrum_master: true },
    });
  });

  it('confirms a reassignment when another member already holds the facet', async () => {
    const user = userEvent.setup();
    membersHolder.data = [
      member({
        id: 'tm-holder',
        user_detail: { id: 'u-2', username: 'carol', email: 'c@x.com' },
        is_scrum_master: true,
      }),
      member(),
    ];
    renderWithRouter(<ProjectTeamPage />);

    await user.click(screen.getByRole('switch', { name: 'Scrum Master: bob' }));
    // No immediate mutation — a confirm appears first.
    expect(mockMutate).not.toHaveBeenCalled();
    expect(screen.getByText(/carol is currently Scrum Master/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Reassign' }));
    expect(mockMutate).toHaveBeenCalledWith({
      membershipId: 'tm-1',
      changes: { is_scrum_master: true },
    });
  });

  it('cancels a reassignment without mutating', async () => {
    const user = userEvent.setup();
    membersHolder.data = [
      member({
        id: 'tm-holder',
        user_detail: { id: 'u-2', username: 'carol', email: 'c@x.com' },
        is_product_owner: true,
      }),
      member(),
    ];
    renderWithRouter(<ProjectTeamPage />);
    await user.click(screen.getByRole('switch', { name: 'Product Owner: bob' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it('is read-only for a plain member (no role select, disabled switches)', () => {
    roleHolder.role = 100; // project Member, and not a team admin row
    membersHolder.data = [member()];
    renderWithRouter(<ProjectTeamPage />);
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Scrum Master: bob' })).toBeDisabled();
  });
});
