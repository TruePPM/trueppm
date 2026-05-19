import { screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { MembersTab } from './MembersTab';
import type { ProjectMembership } from '@/api/types';

// ---------------------------------------------------------------------------
// Hook mocks
// ---------------------------------------------------------------------------

const mockUpdateRole = vi.fn();
const mockRemoveMember = vi.fn();
const mockAddMember = vi.fn();

vi.mock('@/hooks/useProjectId', () => ({
  useProjectId: () => 'proj-1',
}));

vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: { id: 'user-owner', username: 'alice', email: 'alice@example.com' }, isLoading: false }),
}));

vi.mock('@/hooks/useCurrentUserRole', () => ({
  useCurrentUserRole: () => ({ role: 400, isLoading: false }),
}));

vi.mock('../hooks/useMembers', () => ({
  useMembers: () => ({
    data: mockMembers,
    isLoading: false,
    isError: false,
  }),
}));

vi.mock('../hooks/useUpdateMemberRole', () => ({
  useUpdateMemberRole: () => ({ mutate: mockUpdateRole, isPending: false }),
}));

vi.mock('../hooks/useRemoveMember', () => ({
  useRemoveMember: () => ({ mutate: mockRemoveMember, isPending: false }),
}));

vi.mock('../hooks/useAddMember', () => ({
  useAddMember: () => ({ mutate: mockAddMember, isPending: false, error: null }),
}));

vi.mock('../hooks/useUserSearch', () => ({
  useUserSearch: () => ({ data: [], isFetching: false }),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makeOwner = (overrides: Partial<ProjectMembership> = {}): ProjectMembership => ({
  id: 'mem-owner',
  server_version: 1,
  project: 'proj-1',
  user: 'user-owner',
  user_detail: { id: 'user-owner', username: 'alice', email: 'alice@example.com' },
  role: 400,
  role_label: 'Project Admin',
  ...overrides,
});

const makeMember = (overrides: Partial<ProjectMembership> = {}): ProjectMembership => ({
  id: 'mem-bob',
  server_version: 1,
  project: 'proj-1',
  user: 'user-bob',
  user_detail: { id: 'user-bob', username: 'bob', email: 'bob@example.com' },
  role: 100,
  role_label: 'Team Member',
  ...overrides,
});

let mockMembers: ProjectMembership[];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MembersTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMembers = [makeOwner(), makeMember()];
  });

  function render() {
    return renderWithRouter(<MembersTab />, {
      initialEntries: ['/projects/proj-1/settings/members'],
    });
  }

  it('renders the member list', () => {
    render();
    expect(screen.getByText('alice')).toBeInTheDocument();
    expect(screen.getByText('bob')).toBeInTheDocument();
  });

  it('shows (you) label on the current user row', () => {
    render();
    expect(screen.getByText('(you)')).toBeInTheDocument();
  });

  it('shows role badge for OWNER members (non-editable)', () => {
    render();
    expect(screen.getByText('Project Admin')).toBeInTheDocument();
  });

  it('shows role picker for non-OWNER member when current user is OWNER', () => {
    render();
    // bob is role=1 (Team Member) — editable by OWNER alice
    const bobRow = screen.getByText('bob').closest('li')!;
    expect(within(bobRow).getByRole('combobox')).toBeInTheDocument();
  });

  it('calls updateRole when role picker changes', async () => {
    render();
    const bobRow = screen.getByText('bob').closest('li')!;
    const picker = within(bobRow).getByRole('combobox');
    await userEvent.selectOptions(picker, '2'); // Resource Manager
    expect(mockUpdateRole).toHaveBeenCalledWith({ membershipId: 'mem-bob', role: 200 });
  });

  it('calls removeMember when Remove is clicked', async () => {
    render();
    const bobRow = screen.getByText('bob').closest('li')!;
    await userEvent.click(within(bobRow).getByRole('button', { name: /remove bob/i }));
    expect(mockRemoveMember).toHaveBeenCalledWith('mem-bob');
  });

  it('shows leave confirmation when Leave is clicked for self', async () => {
    // Two owners → alice is not the sole owner, so Leave button is available
    mockMembers = [
      makeOwner(),
      makeOwner({ id: 'mem-owner2', user: 'user-carol', user_detail: { id: 'user-carol', username: 'carol', email: 'carol@example.com' } }),
      makeMember(),
    ];
    render();
    const aliceRow = screen.getByText('alice').closest('li')!;
    await userEvent.click(within(aliceRow).getByRole('button', { name: /leave project/i }));
    expect(screen.getByText('Leave project?')).toBeInTheDocument();
  });

  it('disables leave when self is sole owner', () => {
    // Only alice (owner), no other owner
    mockMembers = [makeOwner()];
    render();
    expect(screen.getByText("Can't leave")).toBeInTheDocument();
  });

  it('shows the invite form for OWNER role', () => {
    render();
    expect(screen.getByRole('heading', { name: /add member/i })).toBeInTheDocument();
  });

  it('shows empty state when no members', () => {
    mockMembers = [];
    render();
    expect(screen.getByText(/no members yet/i)).toBeInTheDocument();
  });
});
