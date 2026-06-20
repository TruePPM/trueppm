import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { WorkspaceMembersPage, buildMembersCsv } from './WorkspaceMembersPage';
import type { WorkspaceMember } from '../hooks/useWorkspaceMembers';

// Mock apiClient so we can control responses without a running server.
const { getMock, patchMock, deleteMock, postMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  patchMock: vi.fn(),
  deleteMock: vi.fn(),
  postMock: vi.fn(),
}));

vi.mock('@/api/client', () => ({
  apiClient: {
    get: getMock,
    patch: patchMock,
    delete: deleteMock,
    post: postMock,
  },
}));

const MEMBERS = [
  { id: '1', name: 'Anika Krishnan', initials: 'AK', color: '#3E8C6D', email: 'anika.k@truescope.io', role: 'Admin',  role_value: 300, groups: ['Propulsion', 'Leadership'], project_count: 5, last_active: '2m ago',    status: 'active',      sso: true,  two_fa: true  },
  { id: '2', name: 'Jordan Mehta',   initials: 'JM', color: '#C17A10', email: 'j.mehta@truescope.io', role: 'PM',     role_value: 100, groups: ['Stage'],                  project_count: 3, last_active: '12m ago',   status: 'active',      sso: true,  two_fa: true  },
  { id: '3', name: 'Sam Reyes',      initials: 'SR', color: '#7C3AED', email: 'sam@truescope.io',      role: 'Lead',   role_value: 100, groups: ['Avionics'],               project_count: 2, last_active: '26m ago',   status: 'active',      sso: true,  two_fa: false },
  { id: '4', name: 'Erin Lai',       initials: 'EL', color: '#0EA5E9', email: 'elai@truescope.io',     role: 'Lead',   role_value: 100, groups: ['Ground Ops'],             project_count: 2, last_active: '1h ago',    status: 'active',      sso: true,  two_fa: true  },
  { id: '5', name: 'Maya Kearns',    initials: 'MK', color: '#DC2626', email: 'maya.k@truescope.io',   role: 'Member', role_value: 100, groups: ['Power'],                  project_count: 1, last_active: '3h ago',    status: 'active',      sso: true,  two_fa: true  },
  { id: '6', name: 'Devraj Tan',     initials: 'DT', color: '#0F766E', email: 'dtan@truescope.io',     role: 'Member', role_value: 100, groups: ['Fluids'],                 project_count: 2, last_active: 'Yesterday', status: 'active',      sso: true,  two_fa: true  },
  { id: '7', name: 'Riya Kapoor',    initials: 'RK', color: '#92400E', email: 'rk@truescope.io',       role: 'PM',     role_value: 100, groups: ['Ops', 'Leadership'],      project_count: 4, last_active: 'Yesterday', status: 'active',      sso: true,  two_fa: true  },
  { id: '8', name: 'Theo Vasquez',   initials: 'TV', color: '#475569', email: 'theo@truescope.io',     role: 'Member', role_value: 100, groups: ['Ops'],                    project_count: 2, last_active: '3d ago',    status: 'active',      sso: false, two_fa: false },
  { id: '9', name: 'Park Choi',      initials: 'PC', color: '#7C3AED', email: 'pchoi@vendor.x',        role: 'Viewer', role_value: 100, groups: ['Vendor: ValveCo'],        project_count: 1, last_active: '1w ago',    status: 'guest',       sso: false, two_fa: false },
  { id: '10', name: 'Lin Mae',       initials: 'LM', color: '#3E8C6D', email: 'linmae@truescope.io',   role: 'Member', role_value: 100, groups: ['Avionics'],               project_count: 1, last_active: '2w ago',    status: 'deactivated', sso: true,  two_fa: true  },
];

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  }
  return Wrapper;
}

function setupMocks() {
  getMock.mockImplementation((url: string) => {
    if (url.includes('/workspace/members/')) return Promise.resolve({ data: MEMBERS });
    if (url.includes('/workspace/invites/')) return Promise.resolve({ data: [] });
    return Promise.resolve({ data: [] });
  });
}

describe('WorkspaceMembersPage — search + filters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks();
  });

  it('renders an accessible search input (not a span placeholder)', async () => {
    render(<WorkspaceMembersPage />, { wrapper: makeWrapper() });
    await waitFor(() =>
      expect(screen.getByRole('searchbox', { name: /search members by name or email/i })).toBeInTheDocument(),
    );
  });

  it('renders a Role filter as a real <select>', async () => {
    render(<WorkspaceMembersPage />, { wrapper: makeWrapper() });
    await waitFor(() => {
      const select = screen.getByRole('combobox', { name: /filter by role/i });
      expect(select).toBeInTheDocument();
      expect(select.tagName).toBe('SELECT');
    });
  });

  it('narrows visible rows when typing in the search input', async () => {
    const user = userEvent.setup();
    render(<WorkspaceMembersPage />, { wrapper: makeWrapper() });

    // Wait for data to load
    await waitFor(() => expect(screen.getByText('Anika Krishnan')).toBeInTheDocument());
    expect(screen.getByText('Maya Kearns')).toBeInTheDocument();

    const input = screen.getByRole('searchbox', { name: /search members/i });
    await user.type(input, 'anika');

    expect(screen.getByText('Anika Krishnan')).toBeInTheDocument();
    expect(screen.queryByText('Maya Kearns')).not.toBeInTheDocument();
  });

  it('updates the "Showing N of M" footer when filtered', async () => {
    const user = userEvent.setup();
    render(<WorkspaceMembersPage />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByText(/Showing all 10/)).toBeInTheDocument());

    await user.type(
      screen.getByRole('searchbox', { name: /search members/i }),
      'anika',
    );

    expect(screen.getByText(/Showing 1 of 10/)).toBeInTheDocument();
  });

  it('renders an empty state with the search term when nothing matches', async () => {
    const user = userEvent.setup();
    render(<WorkspaceMembersPage />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByRole('searchbox')).toBeInTheDocument());

    await user.type(
      screen.getByRole('searchbox', { name: /search members/i }),
      'zzzzz',
    );
    expect(screen.getByText('No members match "zzzzz"')).toBeInTheDocument();
  });

  it('narrows visible rows when selecting a Role', async () => {
    const user = userEvent.setup();
    render(<WorkspaceMembersPage />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByText('Sam Reyes')).toBeInTheDocument());

    await user.selectOptions(
      screen.getByRole('combobox', { name: /filter by role/i }),
      'Lead',
    );
    // Two Leads in the fixture: Sam Reyes, Erin Lai
    expect(screen.getByText('Sam Reyes')).toBeInTheDocument();
    expect(screen.getByText('Erin Lai')).toBeInTheDocument();
    expect(screen.queryByText('Anika Krishnan')).not.toBeInTheDocument();
    expect(screen.getByText(/Showing 2 of 10/)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Two-step destructive confirm — member remove
// ---------------------------------------------------------------------------

describe('WorkspaceMembersPage — two-step remove confirm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks();
  });

  it('does NOT call apiClient.delete immediately when the ✕ button is clicked', async () => {
    const user = userEvent.setup();
    render(<WorkspaceMembersPage />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByText('Anika Krishnan')).toBeInTheDocument());

    // The ✕ remove button is labelled "Remove <name>"
    await user.click(screen.getByRole('button', { name: /Remove Anika Krishnan/i }));

    // delete must NOT have been called yet
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('reveals the inline Confirm/Cancel control after clicking ✕', async () => {
    const user = userEvent.setup();
    render(<WorkspaceMembersPage />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByText('Anika Krishnan')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /Remove Anika Krishnan/i }));

    // The confirm group and its two buttons should now be visible
    expect(screen.getByRole('group', { name: /Confirm remove Anika Krishnan/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Confirm$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Cancel$/i })).toBeInTheDocument();
  });

  it('calls apiClient.delete with the member id when Confirm is clicked', async () => {
    const user = userEvent.setup();
    deleteMock.mockResolvedValue({});
    render(<WorkspaceMembersPage />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByText('Anika Krishnan')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /Remove Anika Krishnan/i }));
    await user.click(screen.getByRole('button', { name: /^Confirm$/i }));

    await waitFor(() =>
      expect(deleteMock).toHaveBeenCalledWith('/workspace/members/1/'),
    );
  });

  it('dismisses the confirm control without calling delete when Cancel is clicked', async () => {
    const user = userEvent.setup();
    render(<WorkspaceMembersPage />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByText('Anika Krishnan')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /Remove Anika Krishnan/i }));
    await user.click(screen.getByRole('button', { name: /^Cancel$/i }));

    expect(deleteMock).not.toHaveBeenCalled();
    // The ✕ button should be back, the confirm group gone
    expect(screen.getByRole('button', { name: /Remove Anika Krishnan/i })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: /Confirm remove Anika Krishnan/i })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Inline role="alert" error — member remove failure
// ---------------------------------------------------------------------------

describe('WorkspaceMembersPage — remove error alert', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks();
  });

  it('shows a role="alert" error message when the remove mutation rejects', async () => {
    const user = userEvent.setup();
    deleteMock.mockRejectedValue(new Error('500'));
    render(<WorkspaceMembersPage />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByText('Anika Krishnan')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /Remove Anika Krishnan/i }));
    await user.click(screen.getByRole('button', { name: /^Confirm$/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Action failed\. Try again\./i);
  });
});

// ---------------------------------------------------------------------------
// Inline role="alert" error — invite send failure
// ---------------------------------------------------------------------------

describe('WorkspaceMembersPage — invite error alert', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks();
  });

  it('shows a role="alert" error when the invite mutation rejects', async () => {
    const user = userEvent.setup();
    postMock.mockRejectedValue(new Error('400'));
    render(<WorkspaceMembersPage />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByRole('searchbox')).toBeInTheDocument());

    const emailInput = screen.getByRole('textbox', { name: /Email/i });
    await user.type(emailInput, 'new@example.com');
    await user.click(screen.getByRole('button', { name: /Invite members/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Could not send the invite/i);
  });
});

describe('buildMembersCsv — member CSV export (issue 969)', () => {
  function member(overrides: Partial<WorkspaceMember>): WorkspaceMember {
    return {
      id: '1',
      name: 'Anika Krishnan',
      initials: 'AK',
      color: '#3E8C6D',
      email: 'anika.k@truescope.io',
      role: 'Admin',
      roleValue: 300,
      groups: ['Propulsion', 'Leadership'],
      projectCount: 5,
      lastActive: '2m ago',
      status: 'active',
      sso: true,
      twoFa: true,
      ...overrides,
    };
  }

  it('emits a header row with the visible columns', () => {
    const csv = buildMembersCsv([]);
    expect(csv).toBe('Name,Email,Role,Status,Groups');
  });

  it('serializes name, email, role, status, and semicolon-joined groups per row', () => {
    const csv = buildMembersCsv([member({})]);
    const [, row] = csv.split('\n');
    expect(row).toBe('Anika Krishnan,anika.k@truescope.io,Admin,active,Propulsion; Leadership');
  });

  it('quotes and escapes cells containing commas, quotes, or newlines', () => {
    const csv = buildMembersCsv([
      member({ name: 'Smith, Jordan', groups: ['Ops "core"', 'Line\nbreak'] }),
    ]);
    // Name with a comma is quoted; embedded double-quotes are doubled; the
    // newline in a group keeps the cell quoted so the record stays intact.
    // Assert against the whole CSV — the Groups cell contains an embedded
    // newline, so splitting on '\n' would tear the quoted record in two.
    expect(csv).toContain('"Smith, Jordan"');
    expect(csv).toContain('"Ops ""core""; Line\nbreak"');
  });

  it('renders one row per member', () => {
    const csv = buildMembersCsv([
      member({ id: '1' }),
      member({ id: '2', name: 'Jordan Mehta', email: 'j@x.io' }),
    ]);
    expect(csv.split('\n')).toHaveLength(3); // header + 2 rows
  });
});

describe('WorkspaceMembersPage — Export CSV (issue 969)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks();
  });

  it('enables Export CSV once members load and triggers a CSV download on click', async () => {
    const user = userEvent.setup();
    // Stub the blob/anchor download path so click() doesn't navigate in jsdom.
    const createUrl = vi.fn(() => 'blob:members');
    const revokeUrl = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL: createUrl, revokeObjectURL: revokeUrl });
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});

    render(<WorkspaceMembersPage />, { wrapper: makeWrapper() });

    const exportBtn = await screen.findByRole('button', { name: 'Export CSV' });
    await waitFor(() => expect(exportBtn).toBeEnabled());

    await user.click(exportBtn);

    expect(createUrl).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeUrl).toHaveBeenCalledTimes(1);

    clickSpy.mockRestore();
    vi.unstubAllGlobals();
  });
});

describe('WorkspaceMembersPage — Resend invite (issue 969)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getMock.mockImplementation((url: string) => {
      if (url.includes('/workspace/members/')) return Promise.resolve({ data: MEMBERS });
      if (url.includes('/workspace/invites/'))
        return Promise.resolve({
          data: [
            { id: 'inv1', email: 'pending@truescope.io', role: 'Member', created_at: '2026-05-20', invited_by: 'Anika Krishnan' },
          ],
        });
      return Promise.resolve({ data: [] });
    });
  });

  it('posts to the per-invite resend endpoint and swaps the button for a Sent cue', async () => {
    const user = userEvent.setup();
    postMock.mockResolvedValue({ data: { queued: true } });
    render(<WorkspaceMembersPage />, { wrapper: makeWrapper() });

    const resendBtn = await screen.findByRole('button', {
      name: /Resend invite to pending@truescope.io/i,
    });
    expect(resendBtn).toBeEnabled();
    await user.click(resendBtn);

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/workspace/invites/inv1/resend/'),
    );
    // Fire-and-forget 202 → the row swaps to a reassuring "Sent ✓" cue.
    expect(await screen.findByText('Sent ✓')).toBeInTheDocument();
    // The adjacent Revoke action stays live.
    expect(
      screen.getByRole('button', { name: /Revoke invite for pending@truescope.io/i }),
    ).toBeEnabled();
  });

  it('posts to the bulk resend-all endpoint when "Resend all" is clicked', async () => {
    const user = userEvent.setup();
    postMock.mockResolvedValue({ data: { requeued: 1 } });
    render(<WorkspaceMembersPage />, { wrapper: makeWrapper() });

    const resendAll = await screen.findByRole('button', { name: /Resend all/i });
    expect(resendAll).toBeEnabled();
    await user.click(resendAll);

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/workspace/invites/resend-all/'),
    );
  });
});
