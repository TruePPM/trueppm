import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkspaceDangerPage } from './WorkspaceDangerPage';

/**
 * #4210 — Export / Transfer ownership / Delete are Owner-only server-side, but
 * the page used to render them enabled to any Admin (role 300), who then 403'd
 * on every click. This spec is the role-gate companion to the sibling golden-
 * path specs (which both mock `useIsWorkspaceOwner` as `true` and cover the
 * wired actions themselves).
 */

const startExportMutate = vi.fn();
const transferMutate = vi.fn();
const deleteMutate = vi.fn();

const isWorkspaceOwner = vi.fn<() => boolean | null>();
vi.mock('@/hooks/useIsWorkspaceOwner', () => ({
  useIsWorkspaceOwner: () => isWorkspaceOwner(),
  WORKSPACE_OWNER_ROLE: 400,
}));

vi.mock('../hooks/useWorkspaceSettings', () => ({
  useWorkspaceSettings: () => ({ data: { name: 'Acme', subdomain: 'acme' }, isLoading: false }),
}));
vi.mock('../hooks/useWorkspaceMembers', () => ({
  useWorkspaceMembers: () => ({
    members: [{ id: '2', name: 'Bob Stone', role: 'Member', roleValue: 100, status: 'active' }],
    pendingInvites: [],
    isLoading: false,
  }),
}));
vi.mock('../hooks/useWorkspaceLifecycle', () => ({
  useTransferWorkspaceOwnership: () => ({ mutate: transferMutate, isPending: false }),
  useStartWorkspaceExport: () => ({ mutate: startExportMutate, isPending: false }),
  useWorkspaceExportJob: () => ({ data: undefined }),
  useDeleteWorkspace: () => ({ mutate: deleteMutate, isPending: false, error: null }),
  downloadWorkspaceExport: vi.fn(),
}));
vi.mock('@/stores/authStore', () => ({
  useAuthStore: (selector: (s: { clearTokens: () => void }) => unknown) =>
    selector({ clearTokens: vi.fn() }),
}));

function renderPage() {
  return render(
    <MemoryRouter>
      <WorkspaceDangerPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  startExportMutate.mockClear();
  transferMutate.mockClear();
  deleteMutate.mockClear();
  isWorkspaceOwner.mockReset();
});

describe('WorkspaceDangerPage — Owner gate (#4210)', () => {
  it('an Admin (workspace_role 300) sees every danger-zone control disabled, with the reason stated', () => {
    isWorkspaceOwner.mockReturnValue(false);
    renderPage();

    expect(screen.getByRole('button', { name: 'Export all data' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Transfer ownership/i })).toBeDisabled();
    expect(screen.getByLabelText('New owner')).toBeDisabled();
    expect(
      screen.getByLabelText(/Confirm delete by typing the workspace name/i),
    ).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete workspace permanently' })).toBeDisabled();

    // One "Requires the workspace Owner role." note per gated card.
    expect(screen.getAllByText('Requires the workspace Owner role.')).toHaveLength(3);
  });

  it('an Admin cannot enable Delete even after typing the exact workspace name', () => {
    isWorkspaceOwner.mockReturnValue(false);
    renderPage();

    const input = screen.getByLabelText<HTMLInputElement>(
      /Confirm delete by typing the workspace name/i,
    );
    expect(input).toBeDisabled();
    // The confirm phrase can't even be typed — the input itself stays inert, so
    // there is no path from "knows the name" to an enabled delete button.
    expect(screen.getByRole('button', { name: 'Delete workspace permanently' })).toBeDisabled();
  });

  it('fails closed while the role signal is loading or unresolved (null), same as errored', () => {
    isWorkspaceOwner.mockReturnValue(null);
    renderPage();

    expect(screen.getByRole('button', { name: 'Export all data' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Transfer ownership/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete workspace permanently' })).toBeDisabled();
  });

  it('the Owner (workspace_role 400) sees every control enabled and no gate note', () => {
    isWorkspaceOwner.mockReturnValue(true);
    renderPage();

    expect(screen.getByRole('button', { name: 'Export all data' })).toBeEnabled();
    expect(screen.getByLabelText('New owner')).toBeEnabled();
    // Delete stays gated on the typed confirmation, independent of the role gate.
    expect(screen.getByRole('button', { name: 'Delete workspace permanently' })).toBeDisabled();
    expect(screen.queryByText('Requires the workspace Owner role.')).not.toBeInTheDocument();
  });
});
