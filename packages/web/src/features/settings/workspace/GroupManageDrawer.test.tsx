import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { WorkspaceGroup } from '@/api/types';
import { GroupManageDrawer } from './GroupManageDrawer';

const { getMock, postMock, deleteMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  deleteMock: vi.fn(),
}));

vi.mock('@/api/client', () => ({
  apiClient: { get: getMock, post: postMock, delete: deleteMock },
}));

const GROUP: WorkspaceGroup = {
  id: 'g1',
  name: 'Avionics',
  description: 'Flight systems',
  lead: null,
  leadUserId: null,
  memberCount: 1,
  members: [{ id: '3', name: 'Sam Reyes', initials: 'SR', color: '#7C3AED' }],
  projects: [{ id: 'p1', name: 'Atlas V', role: 100, roleLabel: 'Team Member' }],
};

const RAW_MEMBERS = [
  {
    id: '3',
    name: 'Sam Reyes',
    initials: 'SR',
    color: '#7C3AED',
    email: 'sam@x.io',
    role: 'Team Member',
    role_value: 100,
    groups: [],
    project_count: 1,
    last_active: null,
    status: 'active',
    sso: false,
    two_fa: false,
  },
  {
    id: '5',
    name: 'Dana Cole',
    initials: 'DC',
    color: '#3E8C6D',
    email: 'dana@x.io',
    role: 'Project Manager',
    role_value: 300,
    groups: [],
    project_count: 2,
    last_active: null,
    status: 'active',
    sso: false,
    two_fa: false,
  },
];

const RAW_PROJECTS = [
  { id: 'p1', name: 'Atlas V', start_date: '2026-01-01', calendar: 'c1' },
  { id: 'p9', name: 'Orion', start_date: '2026-01-01', calendar: 'c1' },
];

function setupMocks() {
  getMock.mockImplementation((url: string) => {
    if (url.includes('/workspace/members/'))
      return Promise.resolve({ data: { results: RAW_MEMBERS, next: null } });
    if (url.includes('/workspace/invites/'))
      return Promise.resolve({ data: { results: [], next: null } });
    if (url.includes('/projects/'))
      return Promise.resolve({ data: { results: RAW_PROJECTS, next: null } });
    return Promise.resolve({ data: { results: [], next: null } });
  });
  postMock.mockResolvedValue({ data: {} });
  deleteMock.mockResolvedValue({});
}

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  }
  return Wrapper;
}

describe('GroupManageDrawer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks();
    // Force the desktop (non-modal drawer) branch — matchMedia min-width queries match.
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: true,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
        onchange: null,
      })),
    );
  });

  it('renders the members and project-access sections with existing entries', async () => {
    render(<GroupManageDrawer group={GROUP} onClose={vi.fn()} />, { wrapper: makeWrapper() });

    expect(await screen.findByRole('dialog', { name: 'Avionics' })).toBeInTheDocument();
    expect(screen.getByText('Sam Reyes')).toBeInTheDocument();
    // Existing project grant renders with its conferred role label. Scope to the
    // grant's own row — "Team Member" also appears as a role-select <option>.
    const projectSection = screen.getByRole('region', { name: 'Project access' });
    const grantRow = within(projectSection).getByText('Atlas V').closest('li');
    expect(grantRow).not.toBeNull();
    expect(within(grantRow as HTMLElement).getByText('Team Member')).toBeInTheDocument();
  });

  it('adds a workspace member to the group (POST /members/ with the user id)', async () => {
    const user = userEvent.setup();
    render(<GroupManageDrawer group={GROUP} onClose={vi.fn()} />, { wrapper: makeWrapper() });
    await screen.findByRole('dialog', { name: 'Avionics' });

    // Open the member picker (its trigger is labeled "Add") and choose the only
    // addable workspace member (Sam is already in the group, so only Dana shows).
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await user.click(await screen.findByRole('option', { name: 'Dana Cole' }));

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/workspace/groups/g1/members/', { user: '5' }),
    );
  });

  it('grants a project at the chosen role (POST /projects/ with project + role)', async () => {
    const user = userEvent.setup();
    render(<GroupManageDrawer group={GROUP} onClose={vi.fn()} />, { wrapper: makeWrapper() });
    await screen.findByRole('dialog', { name: 'Avionics' });

    // Pick the project (Atlas V is already linked, so only Orion is grantable).
    await user.click(screen.getByRole('button', { name: 'Choose' }));
    await user.click(await screen.findByRole('option', { name: 'Orion' }));

    // Choose a non-default role, then Grant.
    await user.selectOptions(
      screen.getByLabelText('Role to confer'),
      String(200), // Resource Manager
    );
    await user.click(screen.getByRole('button', { name: 'Grant' }));

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/workspace/groups/g1/projects/', {
        project: 'p9',
        role: 200,
      }),
    );
  });

  it('revokes an existing project grant (DELETE /projects/{id}/)', async () => {
    const user = userEvent.setup();
    render(<GroupManageDrawer group={GROUP} onClose={vi.fn()} />, { wrapper: makeWrapper() });
    await screen.findByRole('dialog', { name: 'Avionics' });

    await user.click(screen.getByRole('button', { name: /Revoke Avionics access to Atlas V/i }));

    await waitFor(() =>
      expect(deleteMock).toHaveBeenCalledWith('/workspace/groups/g1/projects/p1/'),
    );
  });

  it('removes a member (DELETE /members/{id}/)', async () => {
    const user = userEvent.setup();
    render(<GroupManageDrawer group={GROUP} onClose={vi.fn()} />, { wrapper: makeWrapper() });
    await screen.findByRole('dialog', { name: 'Avionics' });

    await user.click(screen.getByRole('button', { name: /Remove Sam Reyes from Avionics/i }));

    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('/workspace/groups/g1/members/3/'));
  });
});
