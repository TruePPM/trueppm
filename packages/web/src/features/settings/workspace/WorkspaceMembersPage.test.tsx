import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

// Toast is a store-backed imperative API; stub it so the resend/resend-all
// outcome copy can be asserted directly.
const { toastSuccess, toastError } = vi.hoisted(() => ({
  toastSuccess: vi.fn<(m: string) => void>(),
  toastError: vi.fn<(m: string) => void>(),
}));

vi.mock('@/components/Toast', () => ({
  toast: {
    success: (m: string) => toastSuccess(m),
    error: (m: string) => toastError(m),
    info: (m: string) => toastSuccess(m),
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
    // /workspace/members/ is cursor-paginated (#1317); /workspace/invites/ is
    // page-number paginated (#1355). fetchAllPages reads .results and follows
    // .next (null → single page) for both.
    if (url.includes('/workspace/members/'))
      return Promise.resolve({ data: { results: MEMBERS, next: null } });
    if (url.includes('/workspace/invites/'))
      return Promise.resolve({ data: { results: [], next: null } });
    return Promise.resolve({ data: { results: [], next: null } });
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

  it('restores every row when the Role filter is reset to "All roles"', async () => {
    const user = userEvent.setup();
    render(<WorkspaceMembersPage />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByText('Sam Reyes')).toBeInTheDocument());
    const roleFilter = screen.getByRole('combobox', { name: /filter by role/i });

    await user.selectOptions(roleFilter, 'Lead');
    expect(screen.queryByText('Anika Krishnan')).not.toBeInTheDocument();

    // Selecting the empty option maps back to a null filter, not the string ''.
    await user.selectOptions(roleFilter, '');
    expect(screen.getByText('Anika Krishnan')).toBeInTheDocument();
    expect(screen.getByText(/Showing all 10/)).toBeInTheDocument();
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

  it('clears the row alert when the retried removal succeeds', async () => {
    const user = userEvent.setup();
    deleteMock.mockRejectedValueOnce(new Error('500')).mockResolvedValue({});
    render(<WorkspaceMembersPage />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByText('Anika Krishnan')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /Remove Anika Krishnan/i }));
    await user.click(screen.getByRole('button', { name: /^Confirm$/i }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Remove Anika Krishnan/i }));
    await user.click(screen.getByRole('button', { name: /^Confirm$/i }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
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

  // #2892: this export carried a quoting-only `csvCell` while the task and risk
  // exports had applied the #2762 formula guard for months. Member display names
  // are user-controlled, so a name beginning `=`/`+`/`-`/`@` executed as a formula
  // the moment an admin opened the file in Excel.
  it.each(['=cmd|\'/C calc\'!A0', '+1+1', '-2+3', '@SUM(A1:A9)', '\tlead', '\rlead'])(
    'neutralizes the formula-trigger prefix %j in a member name',
    (payload) => {
      const csv = buildMembersCsv([member({ name: payload })]);
      const [, row] = csv.split('\n');
      // A leading apostrophe makes the cell literal text in Excel / Sheets /
      // LibreOffice; the payload itself is preserved so the name still reads.
      expect(row.startsWith(`'${payload}`) || row.startsWith(`"'${payload}`)).toBe(true);
    },
  );

  it('quotes an interior lone CR so it cannot split the record', () => {
    // The hole the old `/[",\n]/` regex left: records join on a newline and the
    // formula guard only inspects position 0, so an interior CR ended the record
    // and whatever followed it started the next one unprefixed — smuggling a live
    // formula past a guard that believed it had neutralized the cell.
    const csv = buildMembersCsv([member({ name: "Anika\r=cmd|'/C calc'!A0" })]);
    expect(csv).toContain('"Anika\r=cmd|\'/C calc\'!A0"');
  });

  it('leaves an ordinary name untouched', () => {
    // The guard must not prefix values that were never dangerous, or every
    // export grows a stray apostrophe.
    const csv = buildMembersCsv([member({ name: 'Anika Krishnan' })]);
    expect(csv.split('\n')[1]).toBe(
      'Anika Krishnan,anika.k@truescope.io,Admin,active,Propulsion; Leadership',
    );
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
      // /workspace/members/ is cursor-paginated (#1317); /workspace/invites/ is
      // page-number paginated (#1355). fetchAllPages reads .results and follows
      // .next (null → single page) for both.
      if (url.includes('/workspace/members/'))
        return Promise.resolve({ data: { results: MEMBERS, next: null } });
      if (url.includes('/workspace/invites/'))
        return Promise.resolve({
          data: {
            results: [
              { id: 'inv1', email: 'pending@truescope.io', role: 'Member', created_at: '2026-05-20', invited_by: 'Anika Krishnan' },
            ],
            next: null,
          },
        });
      return Promise.resolve({ data: { results: [], next: null } });
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
    // Fire-and-forget 202 → the row swaps to a reassuring "Sent" cue. The check is a
    // house CheckIcon SVG rather than a "✓" glyph (issue 1749), so anchor on the cue.
    expect(await screen.findByTestId('invite-resent-cue')).toHaveTextContent('Sent');
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

// ---------------------------------------------------------------------------
// Shared fixtures for the branch-coverage suites below
// ---------------------------------------------------------------------------

/** snake_case member row as GET /workspace/members/ returns it. */
interface RawMember {
  id: string;
  name: string;
  initials: string;
  color: string;
  email: string;
  role: string;
  role_value: number;
  groups: string[];
  project_count: number;
  last_active: string | null;
  status: string;
  sso: boolean;
  two_fa: boolean;
}

interface RawInvite {
  id: string;
  email: string;
  role: string;
  role_value: number;
  status: string;
  invited_by: string | null;
  created_at: string;
  expires_at: string;
}

function invite(overrides: Partial<RawInvite> = {}): RawInvite {
  return {
    id: 'inv1',
    email: 'pending@truescope.io',
    role: 'Member',
    role_value: 100,
    status: 'pending',
    invited_by: 'Anika Krishnan',
    created_at: '2026-05-20',
    expires_at: '2026-06-20',
    ...overrides,
  };
}

/** Point the GET mock at a specific member/invite fixture pair. */
function setupData(members: RawMember[], invites: RawInvite[] = []) {
  getMock.mockImplementation((url: string) => {
    if (url.includes('/workspace/members/'))
      return Promise.resolve({ data: { results: members, next: null } });
    if (url.includes('/workspace/invites/'))
      return Promise.resolve({ data: { results: invites, next: null } });
    return Promise.resolve({ data: { results: [], next: null } });
  });
}

// ---------------------------------------------------------------------------
// Loading state
// ---------------------------------------------------------------------------

describe('WorkspaceMembersPage — loading state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders skeleton rows and no controls while the queries are in flight', () => {
    // Never resolves — the page stays in its isLoading branch.
    getMock.mockImplementation(() => new Promise(() => {}));
    const { container } = render(<WorkspaceMembersPage />, { wrapper: makeWrapper() });

    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Export CSV' })).not.toBeInTheDocument();
    expect(container.querySelectorAll('.motion-safe\\:animate-pulse')).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Role change
// ---------------------------------------------------------------------------

describe('WorkspaceMembersPage — role change', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks();
  });

  it('PATCHes the member with the newly selected role integer', async () => {
    const user = userEvent.setup();
    patchMock.mockResolvedValue({ data: {} });
    render(<WorkspaceMembersPage />, { wrapper: makeWrapper() });

    const select = await screen.findByRole('combobox', { name: 'Role for Anika Krishnan' });
    expect(select).toHaveValue('300');
    await user.selectOptions(select, '400');

    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledWith('/workspace/members/1/', { role: 400 }),
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows an inline alert on the touched row when the role PATCH rejects', async () => {
    const user = userEvent.setup();
    patchMock.mockRejectedValue(new Error('500'));
    render(<WorkspaceMembersPage />, { wrapper: makeWrapper() });

    const select = await screen.findByRole('combobox', { name: 'Role for Jordan Mehta' });
    await user.selectOptions(select, '300');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Action failed. Try again.');
    // Only the touched row carries the alert.
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  it('clears the row alert once a later change on the same row succeeds', async () => {
    const user = userEvent.setup();
    patchMock.mockRejectedValueOnce(new Error('500')).mockResolvedValue({ data: {} });
    render(<WorkspaceMembersPage />, { wrapper: makeWrapper() });

    const select = await screen.findByRole('combobox', { name: 'Role for Jordan Mehta' });
    await user.selectOptions(select, '300');
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    await user.selectOptions(select, '400');
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });
});

// ---------------------------------------------------------------------------
// Invite form
// ---------------------------------------------------------------------------

describe('WorkspaceMembersPage — invite form', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks();
  });

  it('POSTs the trimmed email with the chosen role and resets the form on success', async () => {
    const user = userEvent.setup();
    postMock.mockResolvedValue({ data: { id: 'inv9' } });
    render(<WorkspaceMembersPage />, { wrapper: makeWrapper() });

    const email = await screen.findByRole<HTMLInputElement>('textbox', { name: 'Email' });
    const role = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Role' });
    await user.type(email, '  new@example.com  ');
    await user.selectOptions(role, '300');

    await user.click(screen.getByRole('button', { name: /Invite members/i }));

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/workspace/invites/', {
        email: 'new@example.com',
        role: 300,
      }),
    );
    // Success resets both controls to their defaults.
    await waitFor(() => expect(email.value).toBe(''));
    expect(role.value).toBe('100');
  });

  it('keeps the typed address when the invite POST rejects', async () => {
    const user = userEvent.setup();
    postMock.mockRejectedValue(new Error('400'));
    render(<WorkspaceMembersPage />, { wrapper: makeWrapper() });

    const email = await screen.findByRole<HTMLInputElement>('textbox', { name: 'Email' });
    await user.type(email, 'bad@example.com');
    await user.click(screen.getByRole('button', { name: /Invite members/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not send the invite/i);
    expect(email.value).toBe('bad@example.com');
  });

  it('does not POST when the form is submitted with a whitespace-only address', async () => {
    const user = userEvent.setup();
    const { container } = render(<WorkspaceMembersPage />, { wrapper: makeWrapper() });

    const email = await screen.findByRole<HTMLInputElement>('textbox', { name: 'Email' });
    await user.type(email, '   ');
    // The submit button is disabled, so drive the form's submit handler directly.
    expect(screen.getByRole('button', { name: /Invite members/i })).toBeDisabled();
    const form = container.querySelector('form');
    expect(form).not.toBeNull();
    fireEvent.submit(form as HTMLFormElement);

    expect(postMock).not.toHaveBeenCalled();
  });

  it('shows a pending label while the invite POST is in flight', async () => {
    const user = userEvent.setup();
    postMock.mockImplementation(() => new Promise(() => {}));
    render(<WorkspaceMembersPage />, { wrapper: makeWrapper() });

    const email = await screen.findByRole('textbox', { name: 'Email' });
    await user.type(email, 'slow@example.com');
    await user.click(screen.getByRole('button', { name: /Invite members/i }));

    const pending = await screen.findByRole('button', { name: 'Sending…' });
    expect(pending).toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// Pending invite actions — revoke
// ---------------------------------------------------------------------------

describe('WorkspaceMembersPage — revoke invite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupData(MEMBERS, [invite()]);
  });

  it('DELETEs the invite and leaves no error alert on success', async () => {
    const user = userEvent.setup();
    deleteMock.mockResolvedValue({});
    render(<WorkspaceMembersPage />, { wrapper: makeWrapper() });

    await user.click(
      await screen.findByRole('button', { name: /Revoke invite for pending@truescope.io/i }),
    );

    await waitFor(() =>
      expect(deleteMock).toHaveBeenCalledWith('/workspace/invites/inv1/'),
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows an inline alert on the invite row when the revoke rejects', async () => {
    const user = userEvent.setup();
    deleteMock.mockRejectedValue(new Error('500'));
    render(<WorkspaceMembersPage />, { wrapper: makeWrapper() });

    await user.click(
      await screen.findByRole('button', { name: /Revoke invite for pending@truescope.io/i }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not complete. Try again.');
  });

  it('clears the invite alert when a retried revoke succeeds', async () => {
    const user = userEvent.setup();
    deleteMock.mockRejectedValueOnce(new Error('500')).mockResolvedValue({});
    render(<WorkspaceMembersPage />, { wrapper: makeWrapper() });

    const revoke = await screen.findByRole('button', {
      name: /Revoke invite for pending@truescope.io/i,
    });
    await user.click(revoke);
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    await user.click(revoke);
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('clears a failed-revoke alert once the same invite is successfully re-sent', async () => {
    const user = userEvent.setup();
    deleteMock.mockRejectedValue(new Error('500'));
    postMock.mockResolvedValue({ data: {} });
    render(<WorkspaceMembersPage />, { wrapper: makeWrapper() });

    await user.click(
      await screen.findByRole('button', { name: /Revoke invite for pending@truescope.io/i }),
    );
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: /Resend invite to pending@truescope.io/i }),
    );
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(await screen.findByTestId('invite-resent-cue')).toHaveTextContent('Sent');
  });
});

// ---------------------------------------------------------------------------
// Pending invite actions — resend outcomes
// ---------------------------------------------------------------------------

describe('WorkspaceMembersPage — resend invite outcomes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupData(MEMBERS, [invite()]);
  });

  async function clickResend() {
    const user = userEvent.setup();
    render(<WorkspaceMembersPage />, { wrapper: makeWrapper() });
    await user.click(
      await screen.findByRole('button', { name: /Resend invite to pending@truescope.io/i }),
    );
  }

  it('confirms the re-send with a success toast naming the recipient', async () => {
    postMock.mockResolvedValue({ data: {} });
    await clickResend();
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith('Invite re-sent to pending@truescope.io.'),
    );
    expect(toastError).not.toHaveBeenCalled();
  });

  it('explains a 429 throttle rather than a generic failure', async () => {
    postMock.mockRejectedValue({ response: { status: 429 } });
    await clickResend();
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        'Too many resends — wait a minute and try again.',
      ),
    );
  });

  it('explains a 409 (invite no longer resendable)', async () => {
    postMock.mockRejectedValue({ response: { status: 409 } });
    await clickResend();
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith('This invite can no longer be resent.'),
    );
  });

  it('falls back to a generic message for any other resend failure', async () => {
    postMock.mockRejectedValue(new Error('boom'));
    await clickResend();
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith('Could not resend the invite. Please try again.'),
    );
    // The failure also surfaces inline on the row.
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not complete. Try again.');
    // The Resend button stays available for a retry — no premature "Sent" cue.
    expect(screen.queryByTestId('invite-resent-cue')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Pending invite actions — resend all outcomes
// ---------------------------------------------------------------------------

describe('WorkspaceMembersPage — resend all outcomes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupData(MEMBERS, [
      invite(),
      invite({ id: 'inv2', email: 'second@truescope.io', role: 'Owner' }),
    ]);
  });

  async function clickResendAll() {
    const user = userEvent.setup();
    render(<WorkspaceMembersPage />, { wrapper: makeWrapper() });
    await user.click(await screen.findByRole('button', { name: /Resend all/i }));
  }

  it('pluralizes the confirmation and marks every row sent when several are re-queued', async () => {
    postMock.mockResolvedValue({ data: { requeued: 2 } });
    await clickResendAll();

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Re-sent 2 invites.'));
    expect(await screen.findAllByTestId('invite-resent-cue')).toHaveLength(2);
  });

  it('uses the singular form when exactly one invite is re-queued', async () => {
    postMock.mockResolvedValue({ data: { requeued: 1 } });
    await clickResendAll();
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Re-sent 1 invite.'));
  });

  it('says nothing was re-queued when every invite is already sending', async () => {
    postMock.mockResolvedValue({ data: { requeued: 0 } });
    await clickResendAll();
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith('All pending invites are already sending.'),
    );
  });

  it('explains a 429 throttle on the bulk resend', async () => {
    postMock.mockRejectedValue({ response: { status: 429 } });
    await clickResendAll();
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        'Too many resends — wait a minute and try again.',
      ),
    );
    expect(screen.queryByTestId('invite-resent-cue')).not.toBeInTheDocument();
  });

  it('falls back to a generic message for any other bulk-resend failure', async () => {
    postMock.mockRejectedValue(new Error('boom'));
    await clickResendAll();
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith('Could not resend invites. Please try again.'),
    );
  });

  it('shows a pending label on the bulk action while it is in flight', async () => {
    postMock.mockImplementation(() => new Promise(() => {}));
    await clickResendAll();
    const pending = await screen.findByRole('button', { name: 'Resending…' });
    expect(pending).toBeDisabled();
  });

  it('renders a badge for a pending-invite role outside the palette', async () => {
    postMock.mockResolvedValue({ data: { requeued: 0 } });
    render(<WorkspaceMembersPage />, { wrapper: makeWrapper() });
    // "Owner" has no ROLE_PALETTE entry — it must still render, using the
    // Member fallback styling rather than crashing on the undefined lookup.
    // Scope to the invite row so the "Owner" <option> in the role selects
    // does not collide.
    const ownerRow = (await screen.findByText('second@truescope.io')).closest('div.grid');
    expect(ownerRow).not.toBeNull();
    expect(within(ownerRow as HTMLElement).getByText('Owner')).toBeInTheDocument();

    const memberRow = (await screen.findByText('pending@truescope.io')).closest('div.grid');
    expect(within(memberRow as HTMLElement).getByText('Member')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Member row rendering variants
// ---------------------------------------------------------------------------

describe('WorkspaceMembersPage — member row variants', () => {
  const VARIANTS: RawMember[] = [
    {
      id: 'v1',
      name: 'Guest Gupta',
      initials: 'GG',
      color: '#7C3AED',
      email: 'gg@vendor.x',
      role: 'Viewer',
      role_value: 100,
      groups: ['Alpha', 'Beta', 'Gamma', 'Delta'],
      project_count: 1,
      last_active: null,
      status: 'guest',
      sso: false,
      two_fa: false,
    },
    {
      id: 'v2',
      name: 'Secure Singh',
      initials: 'SS',
      color: '#3E8C6D',
      email: 'ss@truescope.io',
      role: 'Admin',
      role_value: 300,
      groups: ['Omega'],
      project_count: 4,
      last_active: '5m ago',
      status: 'active',
      sso: true,
      two_fa: true,
    },
    {
      // A status the client does not have a dot color for — the row must still
      // render rather than blanking the status cell.
      id: 'v3',
      name: 'Pending Park',
      initials: 'PP',
      color: '#475569',
      email: 'pp@truescope.io',
      role: 'Member',
      role_value: 100,
      groups: ['Sigma'],
      project_count: 0,
      last_active: '1d ago',
      status: 'invited',
      sso: false,
      two_fa: false,
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    setupData(VARIANTS);
  });

  it('renders an unrecognized member status without dropping the row', async () => {
    render(<WorkspaceMembersPage />, { wrapper: makeWrapper() });
    expect(await screen.findByText('Pending Park')).toBeInTheDocument();
    expect(screen.getByText('invited')).toBeInTheDocument();
  });

  it('flags a guest member and collapses group overflow to a +N counter', async () => {
    render(<WorkspaceMembersPage />, { wrapper: makeWrapper() });

    expect(await screen.findByText('Guest Gupta')).toBeInTheDocument();
    expect(screen.getByText('GUEST')).toBeInTheDocument();
    // Only the first two groups render; the rest collapse to "+2".
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(screen.queryByText('Gamma')).not.toBeInTheDocument();
    expect(screen.getByText('+2')).toBeInTheDocument();
  });

  it('renders an em dash for a member who has never been active', async () => {
    render(<WorkspaceMembersPage />, { wrapper: makeWrapper() });
    expect(await screen.findByText('Guest Gupta')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('shows SSO and 2FA badges only for the member that has them', async () => {
    render(<WorkspaceMembersPage />, { wrapper: makeWrapper() });
    expect(await screen.findByText('Secure Singh')).toBeInTheDocument();
    // One member has both; the guest has neither.
    expect(screen.getAllByText('SSO')).toHaveLength(1);
    expect(screen.getAllByText('2FA')).toHaveLength(1);
  });

  it('renders the role filter empty state when a role matches nothing', async () => {
    const user = userEvent.setup();
    render(<WorkspaceMembersPage />, { wrapper: makeWrapper() });

    await screen.findByText('Guest Gupta');
    await user.selectOptions(screen.getByRole('combobox', { name: /filter by role/i }), 'Lead');

    // No search term is active, so the copy is the filter variant, not the
    // "no members match <query>" variant.
    expect(screen.getByText('No members match the selected filters')).toBeInTheDocument();
    expect(screen.getByText(/Showing 0 of 3/)).toBeInTheDocument();
  });

  it('disables Export CSV and explains why when the filter hides every row', async () => {
    const user = userEvent.setup();
    render(<WorkspaceMembersPage />, { wrapper: makeWrapper() });

    await screen.findByText('Guest Gupta');
    await user.type(screen.getByRole('searchbox', { name: /search members/i }), 'zzzzz');

    const exportBtn = screen.getByRole('button', { name: 'Export CSV' });
    expect(exportBtn).toBeDisabled();
    expect(exportBtn).toHaveAttribute('title', 'No members to export');
  });

  it('describes the export target when rows are visible', async () => {
    render(<WorkspaceMembersPage />, { wrapper: makeWrapper() });
    const exportBtn = await screen.findByRole('button', { name: 'Export CSV' });
    await waitFor(() => expect(exportBtn).toBeEnabled());
    expect(exportBtn).toHaveAttribute('title', 'Download the visible members as a CSV file');
  });
});

describe('WorkspaceMembersPage — contextual help (#2266)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks();
  });

  it('exposes a FieldHelp ⓘ on the invite Role select deep-linking to the RBAC docs', async () => {
    const user = userEvent.setup();
    render(<WorkspaceMembersPage />, { wrapper: makeWrapper() });

    const trigger = await screen.findByRole('button', {
      name: /About the Workspace role options/i,
    });
    await user.click(trigger);

    const dialog = screen.getByRole('dialog', { name: /Workspace role/i });
    const learnMore = within(dialog).getByRole('link', { name: /Learn more/i });
    expect(learnMore).toHaveAttribute('href', expect.stringContaining('rbac'));
  });
});
