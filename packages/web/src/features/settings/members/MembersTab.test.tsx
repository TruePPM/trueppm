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

vi.mock('@/hooks/useProject', () => ({
  useProject: () => ({ data: { default_member_role: 100 }, isLoading: false }),
}));

vi.mock('@/hooks/useProjectMutations', () => ({
  useUpdateProject: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
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
  joined_at: '2026-04-12T12:00:00Z',
  role_changed_at: null,
  other_active_project_count: 0,
  other_active_project_names: [],
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
  joined_at: '2026-04-12T12:00:00Z',
  role_changed_at: null,
  other_active_project_count: 0,
  other_active_project_names: [],
  ...overrides,
});

// Format an ISO timestamp exactly as MemberRow does, so date assertions stay
// correct regardless of the CI runner's timezone.
const fmt = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

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
    // bob is ROLE_MEMBER (Team Member) — editable by OWNER alice
    const bobRow = screen.getByText('bob').closest('li')!;
    expect(within(bobRow).getByRole('combobox')).toBeInTheDocument();
  });

  it('calls updateRole when role picker changes', async () => {
    render();
    const bobRow = screen.getByText('bob').closest('li')!;
    const picker = within(bobRow).getByRole('combobox');
    await userEvent.selectOptions(picker, '200'); // Resource Manager
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

  it('shows the default-member-role setting for Admin+ (ADR-0363)', () => {
    render();
    expect(
      screen.getByRole('heading', { name: /default role for new members/i }),
    ).toBeInTheDocument();
  });

  it('shows empty state when no members', () => {
    mockMembers = [];
    render();
    expect(screen.getByText(/no members yet/i)).toBeInTheDocument();
  });

  // Per-project access evidence (#590)
  it('shows the join date and omits the role-change line when role_changed_at is null', () => {
    mockMembers = [makeMember({ joined_at: '2026-04-12T12:00:00Z', role_changed_at: null })];
    render();
    const bobRow = screen.getByText('bob').closest('li')!;
    expect(within(bobRow).getByText(new RegExp(`Joined ${fmt('2026-04-12T12:00:00Z')}`))).toBeInTheDocument();
    expect(within(bobRow).queryByText(/Role changed/)).not.toBeInTheDocument();
  });

  it('shows both the join date and the role-change date when role_changed_at is after joined_at', () => {
    mockMembers = [
      makeMember({ joined_at: '2026-04-12T12:00:00Z', role_changed_at: '2026-05-01T12:00:00Z' }),
    ];
    render();
    const bobRow = screen.getByText('bob').closest('li')!;
    expect(within(bobRow).getByText(new RegExp(`Joined ${fmt('2026-04-12T12:00:00Z')}`))).toBeInTheDocument();
    expect(within(bobRow).getByText(new RegExp(`Role changed ${fmt('2026-05-01T12:00:00Z')}`))).toBeInTheDocument();
  });

  // Other-active-projects badge (#598)
  it('shows the other-active-projects badge when the count is positive', () => {
    mockMembers = [makeMember({ other_active_project_count: 3 })];
    render();
    const bobRow = screen.getByText('bob').closest('li')!;
    expect(within(bobRow).getByText('+3 other projects')).toBeInTheDocument();
  });

  it('uses the singular noun for a count of one', () => {
    mockMembers = [makeMember({ other_active_project_count: 1 })];
    render();
    const bobRow = screen.getByText('bob').closest('li')!;
    expect(within(bobRow).getByText('+1 other project')).toBeInTheDocument();
  });

  it('omits the badge when the member is on no other active project', () => {
    mockMembers = [makeMember({ other_active_project_count: 0 })];
    render();
    const bobRow = screen.getByText('bob').closest('li')!;
    expect(within(bobRow).queryByText(/other project/)).not.toBeInTheDocument();
  });

  it('lists visible project names in the badge tooltip', () => {
    mockMembers = [
      makeMember({ other_active_project_count: 2, other_active_project_names: ['Apollo', 'Gemini'] }),
    ];
    render();
    const bobRow = screen.getByText('bob').closest('li')!;
    expect(within(bobRow).getByText('+2 other projects')).toHaveAttribute(
      'title',
      'Also on: Apollo, Gemini',
    );
  });

  it('falls back to a count-only tooltip when no names are visible to the viewer', () => {
    mockMembers = [makeMember({ other_active_project_count: 2, other_active_project_names: [] })];
    render();
    const bobRow = screen.getByText('bob').closest('li')!;
    expect(within(bobRow).getByText('+2 other projects')).toHaveAttribute(
      'title',
      'On 2 other active projects',
    );
  });
});
