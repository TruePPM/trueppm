import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkspaceDangerPage } from './WorkspaceDangerPage';

const startExportMutate = vi.fn();
const transferMutate = vi.fn();
const deleteMutate = vi.fn();

vi.mock('../hooks/useWorkspaceSettings', () => ({
  useWorkspaceSettings: () => ({ data: { name: 'Acme', subdomain: 'acme' }, isLoading: false }),
}));
vi.mock('../hooks/useWorkspaceMembers', () => ({
  useWorkspaceMembers: () => ({
    members: [
      { id: '2', name: 'Bob Stone', role: 'Member', roleValue: 100, status: 'active' },
      { id: '3', name: 'Old Owner', role: 'Owner', roleValue: 400, status: 'active' },
      { id: '4', name: 'Ghost', role: 'Member', roleValue: 100, status: 'deactivated' },
    ],
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

describe('WorkspaceDangerPage (#641 wired)', () => {
  beforeEach(() => {
    startExportMutate.mockClear();
    transferMutate.mockClear();
    deleteMutate.mockClear();
  });

  it('renders the three lifecycle actions as live controls (not stubs)', () => {
    renderPage();
    expect(screen.getByRole('button', { name: 'Export all data' })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Transfer ownership/i })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Delete workspace permanently' }),
    ).toBeInTheDocument();
  });

  it('queues an export when "Export all data" is clicked', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Export all data' }));
    expect(startExportMutate).toHaveBeenCalledTimes(1);
  });

  it('only offers non-owner active members as transfer targets', () => {
    renderPage();
    const select = screen.getByLabelText('New owner');
    const options = Array.from(select.querySelectorAll('option')).map((o) => o.textContent);
    expect(options.some((t) => t?.includes('Bob Stone'))).toBe(true);
    // Existing owner and deactivated members are excluded.
    expect(options.some((t) => t?.includes('Old Owner'))).toBe(false);
    expect(options.some((t) => t?.includes('Ghost'))).toBe(false);
  });

  it('gates the transfer button until a member is selected', () => {
    renderPage();
    const transferBtn = screen.getByRole('button', { name: /Transfer ownership/i });
    expect(transferBtn).toBeDisabled();
    fireEvent.change(screen.getByLabelText('New owner'), { target: { value: '2' } });
    expect(transferBtn).toBeEnabled();
    fireEvent.click(transferBtn);
    expect(transferMutate).toHaveBeenCalledWith(2, expect.any(Object));
  });

  it('gives each destructive card a docs "Learn more" link (#2266)', () => {
    renderPage();
    const links = screen.getAllByRole('link', { name: /Learn more/i });
    const hrefs = links.map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('https://docs.trueppm.com/administration/data-export');
    expect(hrefs).toContain('https://docs.trueppm.com/administration/rbac');
    expect(hrefs).toContain('https://docs.trueppm.com/administration/workspace-settings');
    // All three open in a new tab safely.
    links.forEach((a) => {
      expect(a).toHaveAttribute('target', '_blank');
      expect(a).toHaveAttribute('rel', expect.stringContaining('noopener'));
    });
  });

  it('keeps Delete disabled until the workspace name is typed exactly', () => {
    renderPage();
    const deleteBtn = screen.getByRole('button', { name: 'Delete workspace permanently' });
    const input = screen.getByLabelText(/Confirm delete by typing the workspace name/i);
    expect(deleteBtn).toBeDisabled();
    fireEvent.change(input, { target: { value: 'acme' } }); // wrong case
    expect(deleteBtn).toBeDisabled();
    fireEvent.change(input, { target: { value: 'Acme' } });
    expect(deleteBtn).toBeEnabled();
    fireEvent.click(deleteBtn);
    expect(deleteMutate).toHaveBeenCalledWith('Acme', expect.any(Object));
  });
});
