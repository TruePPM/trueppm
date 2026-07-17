import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SyncStatusView } from '@/hooks/useSyncStatus';
import { SyncStatusBadge } from './SyncStatusBadge';

// The badge is a pure projection of useSyncStatus (ADR-0205); mock the hook so
// each state can be driven deterministically without a QueryClient.
const mockRetry = vi.fn().mockResolvedValue(undefined);
let mockView: SyncStatusView;

vi.mock('@/hooks/useSyncStatus', () => ({
  useSyncStatus: (): SyncStatusView => mockView,
  useRetrySync: () => mockRetry,
}));

function viewFor(overrides: Partial<SyncStatusView>): SyncStatusView {
  return {
    status: { kind: 'synced', lastSyncAt: null },
    pendingWrites: [],
    lastError: null,
    lastSyncAt: null,
    pendingPeak: 0,
    ...overrides,
  };
}

describe('SyncStatusBadge', () => {
  beforeEach(() => {
    mockRetry.mockClear();
    mockView = viewFor({});
  });

  it('renders the Synced label silently when everything is saved', () => {
    render(<SyncStatusBadge />);
    expect(screen.getByRole('button', { name: /Synced/ })).toBeInTheDocument();
  });

  it('shows the in-flight count while syncing', () => {
    mockView = viewFor({ status: { kind: 'syncing', count: 2, lastSyncAt: null } });
    render(<SyncStatusBadge />);
    expect(screen.getByRole('button', { name: /Syncing 2 changes/ })).toBeInTheDocument();
  });

  it('shows the pending count and calm-offline label when offline', () => {
    mockView = viewFor({
      status: { kind: 'offline', pending: 3, lastSyncAt: null },
      pendingWrites: [
        { id: 1, label: 'Update task "Alpha"', state: 'queued' },
        { id: 2, label: 'Create risk', state: 'queued' },
        { id: 3, label: 'Move milestone', state: 'queued' },
      ],
    });
    render(<SyncStatusBadge />);
    expect(screen.getByRole('button', { name: /Offline\. 3 changes pending/ })).toBeInTheDocument();
    expect(screen.getByText('Offline · 3 pending')).toBeInTheDocument();
  });

  it('surfaces the error state', () => {
    mockView = viewFor({
      status: { kind: 'error', errorCount: 1, lastError: '409 conflict', lastSyncAt: null },
      lastError: '409 conflict',
      pendingWrites: [{ id: 9, label: 'Save task', state: 'failed' }],
    });
    render(<SyncStatusBadge />);
    expect(screen.getByRole('button', { name: /Sync error/ })).toBeInTheDocument();
  });

  it('surfaces the stale state when live updates are down (#2053)', () => {
    // The whole point: a mobile user (StatusBar is hidden below md) must see a
    // degraded cue instead of a falsely-reassuring "Synced".
    mockView = viewFor({ status: { kind: 'stale', lastSyncAt: null } });
    render(<SyncStatusBadge />);
    expect(screen.getByRole('button', { name: /Live updates are disconnected/ })).toBeInTheDocument();
    expect(screen.getByText('Not live')).toBeInTheDocument();
  });

  it('explains the degraded live-updates state in the modal', () => {
    mockView = viewFor({ status: { kind: 'stale', lastSyncAt: null } });
    render(<SyncStatusBadge />);
    fireEvent.click(screen.getByRole('button', { name: /Live updates are disconnected/ }));

    const dialog = screen.getByRole('dialog', { name: 'Sync status' });
    expect(within(dialog).getByText('Live updates disconnected')).toBeInTheDocument();
    // Not an error: no pending writes, so no retry button is offered.
    expect(within(dialog).queryByRole('button', { name: 'Retry now' })).not.toBeInTheDocument();
  });

  it('opens the modal with the pending-write list on click', () => {
    mockView = viewFor({
      status: { kind: 'offline', pending: 1, lastSyncAt: null },
      pendingWrites: [{ id: 1, label: 'Update task "Alpha"', state: 'queued' }],
    });
    render(<SyncStatusBadge />);
    fireEvent.click(screen.getByRole('button', { name: /Offline/ }));

    const dialog = screen.getByRole('dialog', { name: 'Sync status' });
    expect(within(dialog).getByText('Pending changes (1)')).toBeInTheDocument();
    expect(within(dialog).getByText('Update task "Alpha"')).toBeInTheDocument();
  });

  it('shows the last error detail in the modal', () => {
    mockView = viewFor({
      status: { kind: 'error', errorCount: 1, lastError: '409 conflict on Alpha', lastSyncAt: null },
      lastError: '409 conflict on Alpha',
      pendingWrites: [{ id: 9, label: 'Save task', state: 'failed' }],
    });
    render(<SyncStatusBadge />);
    fireEvent.click(screen.getByRole('button', { name: /Sync error/ }));

    const dialog = screen.getByRole('dialog', { name: 'Sync status' });
    expect(within(dialog).getByText('Last error')).toBeInTheDocument();
    expect(within(dialog).getByText('409 conflict on Alpha')).toBeInTheDocument();
  });

  it('invokes retry from the modal when writes are pending', () => {
    mockView = viewFor({
      status: { kind: 'error', errorCount: 1, lastError: 'boom', lastSyncAt: null },
      lastError: 'boom',
      pendingWrites: [{ id: 9, label: 'Save task', state: 'failed' }],
    });
    render(<SyncStatusBadge />);
    fireEvent.click(screen.getByRole('button', { name: /Sync error/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry now' }));
    expect(mockRetry).toHaveBeenCalledTimes(1);
  });

  it('closes the modal on Escape', () => {
    render(<SyncStatusBadge />);
    fireEvent.click(screen.getByRole('button', { name: /Synced/ }));
    expect(screen.getByRole('dialog', { name: 'Sync status' })).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Sync status' })).not.toBeInTheDocument();
  });
});
