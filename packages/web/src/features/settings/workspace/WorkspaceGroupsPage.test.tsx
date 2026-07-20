import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { WorkspaceGroupsPage } from './WorkspaceGroupsPage';

// Mock apiClient so we can control responses without a running server.
const { getMock, postMock, patchMock, deleteMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  patchMock: vi.fn(),
  deleteMock: vi.fn(),
}));

vi.mock('@/api/client', () => ({
  apiClient: {
    get: getMock,
    post: postMock,
    patch: patchMock,
    delete: deleteMock,
  },
}));

// EnterpriseBadge (rendered next to the disabled "Sync from directory" button)
// reads the edition. Mock it to community so the upsell badge renders.
vi.mock('@/hooks/useEdition', () => ({
  useEdition: vi.fn(() => ({ edition: 'community', isLoading: false })),
}));

const GROUPS = [
  {
    id: 'g1',
    name: 'Avionics',
    description: 'Flight systems and navigation',
    lead: 'SR',
    lead_user_id: '3',
    member_count: 4,
    members: [],
    projects: [
      { id: 'p1', name: 'Atlas V', role: 100, role_label: 'Team Member' },
      { id: 'p2', name: 'Falcon Heavy', role: 200, role_label: 'Resource Manager' },
    ],
  },
  {
    id: 'g2',
    name: 'Propulsion',
    description: 'Engine and thrust subsystems',
    lead: null,
    lead_user_id: null,
    member_count: 7,
    members: [],
    projects: [],
  },
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
    // /workspace/groups/ returns the standard page-number envelope (#1355).
    if (url.includes('/workspace/groups/'))
      return Promise.resolve({ data: { results: GROUPS, next: null } });
    return Promise.resolve({ data: { results: [], next: null } });
  });
}

// ---------------------------------------------------------------------------
// Two-step destructive confirm — group delete
// ---------------------------------------------------------------------------

describe('WorkspaceGroupsPage — two-step delete confirm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks();
  });

  it('does NOT call apiClient.delete immediately when the ✕ button is clicked', async () => {
    const user = userEvent.setup();
    render(<WorkspaceGroupsPage />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByText('Avionics')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /Delete group Avionics/i }));

    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('reveals the inline Confirm/Cancel control after clicking ✕', async () => {
    const user = userEvent.setup();
    render(<WorkspaceGroupsPage />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByText('Avionics')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /Delete group Avionics/i }));

    // The confirm group and its two action buttons must now be present
    expect(screen.getByRole('group', { name: /Confirm delete Avionics/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Confirm$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Cancel$/i })).toBeInTheDocument();
  });

  it('calls apiClient.delete with the group id when Confirm is clicked', async () => {
    const user = userEvent.setup();
    deleteMock.mockResolvedValue({});
    render(<WorkspaceGroupsPage />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByText('Avionics')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /Delete group Avionics/i }));
    await user.click(screen.getByRole('button', { name: /^Confirm$/i }));

    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('/workspace/groups/g1/'));
  });

  it('dismisses the confirm control without calling delete when Cancel is clicked', async () => {
    const user = userEvent.setup();
    render(<WorkspaceGroupsPage />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByText('Avionics')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /Delete group Avionics/i }));
    await user.click(screen.getByRole('button', { name: /^Cancel$/i }));

    expect(deleteMock).not.toHaveBeenCalled();
    // The ✕ button should be back, the confirm group gone
    expect(screen.getByRole('button', { name: /Delete group Avionics/i })).toBeInTheDocument();
    expect(
      screen.queryByRole('group', { name: /Confirm delete Avionics/i }),
    ).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Inline role="alert" error — group delete failure
// ---------------------------------------------------------------------------

describe('WorkspaceGroupsPage — delete error alert', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks();
  });

  it('shows a role="alert" error message when the delete mutation rejects', async () => {
    const user = userEvent.setup();
    deleteMock.mockRejectedValue(new Error('500'));
    render(<WorkspaceGroupsPage />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByText('Avionics')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /Delete group Avionics/i }));
    await user.click(screen.getByRole('button', { name: /^Confirm$/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Could not delete this group\. Try again\./i);
  });
});

// ---------------------------------------------------------------------------
// Inline role="alert" error — group create failure
// ---------------------------------------------------------------------------

describe('WorkspaceGroupsPage — create error alert', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks();
  });

  it('shows a role="alert" error when the create mutation rejects', async () => {
    const user = userEvent.setup();
    postMock.mockRejectedValue(new Error('400'));
    render(<WorkspaceGroupsPage />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByText('Avionics')).toBeInTheDocument());

    // Open the create form
    await user.click(screen.getByRole('button', { name: /\+ Create group/i }));

    const nameInput = screen.getByRole('textbox', { name: /Name/i });
    await user.type(nameInput, 'New Team');
    await user.click(screen.getByRole('button', { name: /^Create$/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Could not create the group\. Try again\./i);
  });
});

describe('WorkspaceGroupsPage — directory sync is an Enterprise affordance (#791)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks();
  });

  it('disables "Sync from directory" and surfaces an Enterprise upsell badge', async () => {
    render(<WorkspaceGroupsPage />, { wrapper: makeWrapper() });
    await waitFor(() => expect(screen.getByText('Avionics')).toBeInTheDocument());

    expect(screen.getByRole('button', { name: 'Sync from directory' })).toBeDisabled();
    // The EnterpriseBadge is the reachable upsell link (rule 121 / #541).
    const ee = screen.getByRole('link', { name: /Available in TruePPM Enterprise/i });
    expect(ee).toHaveAttribute('href', 'https://trueppm.com/enterprise');

    // Manual group creation stays OSS — the adjacent action is still live.
    expect(screen.getByRole('button', { name: '+ Create group' })).toBeEnabled();
  });
});
