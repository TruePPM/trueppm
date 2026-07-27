import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceMember } from '@/api/types';
import type { WorkspaceExportJob } from '../hooks/useWorkspaceLifecycle';
import { WorkspaceDangerPage } from './WorkspaceDangerPage';

/**
 * Branch-coverage companion to `WorkspaceDangerPage.test.tsx`. The sibling spec
 * covers the wired golden paths; this one drives every export-status state, both
 * mutation outcomes, the error-message fallbacks, and the not-yet-loaded
 * workspace guard (#2459).
 */

interface MutateOpts<T = void> {
  onSuccess?: (value: T) => void;
  onError?: (err: unknown) => void;
}

const transferMutate = vi.fn<(id: number, opts?: MutateOpts) => void>();
const startExportMutate = vi.fn<(vars: undefined, opts?: MutateOpts<WorkspaceExportJob>) => void>();
const deleteMutate = vi.fn<(name: string, opts?: MutateOpts) => void>();
const downloadMock = vi.fn<(job: WorkspaceExportJob) => Promise<void>>();
const clearTokens = vi.fn<() => void>();

function makeJob(overrides: Partial<WorkspaceExportJob> = {}): WorkspaceExportJob {
  return {
    id: 'job-1',
    status: 'pending',
    fileSize: null,
    errorDetail: '',
    expiresAt: null,
    createdAt: '2026-07-01T00:00:00Z',
    startedAt: null,
    completedAt: null,
    downloadUrl: null,
    ...overrides,
  };
}

function makeMember(overrides: Partial<WorkspaceMember> = {}): WorkspaceMember {
  return {
    id: '2',
    name: 'Bob Stone',
    initials: 'BS',
    color: '#123456',
    email: 'bob@example.com',
    role: 'Member',
    roleValue: 100,
    groups: [],
    projectCount: 0,
    lastActive: null,
    status: 'active',
    sso: false,
    twoFa: false,
    ...overrides,
  };
}

// Mutable hook state — each test sets the slice it needs before rendering.
let workspace: { name: string } | undefined = { name: 'Acme' };
let members: WorkspaceMember[] = [makeMember()];
let exportJob: WorkspaceExportJob | undefined;
let startExportPending = false;
let transferPending = false;
let deletePending = false;
let deleteMutationError: unknown = null;

vi.mock('../hooks/useWorkspaceSettings', () => ({
  useWorkspaceSettings: () => ({ data: workspace, isLoading: false }),
}));
vi.mock('../hooks/useWorkspaceMembers', () => ({
  useWorkspaceMembers: () => ({ members, pendingInvites: [], isLoading: false }),
}));
vi.mock('../hooks/useWorkspaceLifecycle', () => ({
  useTransferWorkspaceOwnership: () => ({ mutate: transferMutate, isPending: transferPending }),
  useStartWorkspaceExport: () => ({ mutate: startExportMutate, isPending: startExportPending }),
  useWorkspaceExportJob: () => ({ data: exportJob }),
  useDeleteWorkspace: () => ({
    mutate: deleteMutate,
    isPending: deletePending,
    error: deleteMutationError,
  }),
  downloadWorkspaceExport: (job: WorkspaceExportJob) => downloadMock(job),
}));
vi.mock('@/stores/authStore', () => ({
  useAuthStore: (selector: (s: { clearTokens: () => void }) => unknown) =>
    selector({ clearTokens }),
}));

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/settings/workspace/danger']}>
      <Routes>
        <Route path="/settings/workspace/danger" element={<WorkspaceDangerPage />} />
        <Route path="/login" element={<div>Sign in to TruePPM</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  transferMutate.mockReset();
  startExportMutate.mockReset();
  deleteMutate.mockReset();
  downloadMock.mockReset().mockResolvedValue(undefined);
  clearTokens.mockReset();
  workspace = { name: 'Acme' };
  members = [makeMember()];
  exportJob = undefined;
  startExportPending = false;
  transferPending = false;
  deletePending = false;
  deleteMutationError = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('WorkspaceDangerPage — export states', () => {
  it('shows no export status line before any job exists', () => {
    renderPage();
    expect(screen.getByRole('button', { name: 'Export all data' })).toBeEnabled();
    expect(screen.getByRole('status')).toHaveTextContent('');
  });

  it.each(['pending', 'running'] as const)('blocks a second export while %s', (status) => {
    exportJob = makeJob({ status });
    renderPage();
    const button = screen.getByRole('button', { name: 'Building export…' });
    expect(button).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(/Queued — this can take a while/);
  });

  it('blocks the button while the queue request itself is in flight', () => {
    startExportPending = true;
    renderPage();
    expect(screen.getByRole('button', { name: 'Building export…' })).toBeDisabled();
  });

  it('offers the archive download once the job succeeds', () => {
    exportJob = makeJob({ status: 'success', downloadUrl: 'https://example.test/a.tar.gz' });
    renderPage();
    expect(screen.getByRole('button', { name: 'Download archive' })).toBeEnabled();
    expect(screen.getByRole('status')).toHaveTextContent('Ready to download.');
    expect(screen.queryByRole('button', { name: /Export all data/ })).not.toBeInTheDocument();
  });

  it('reports a failed job and re-offers the export', () => {
    exportJob = makeJob({ status: 'failed', errorDetail: 'disk full' });
    renderPage();
    expect(screen.getByRole('status')).toHaveTextContent('Last export failed — try again.');
    expect(screen.getByRole('button', { name: 'Export all data' })).toBeEnabled();
  });

  it('confirms the queued export with a polite toast', () => {
    startExportMutate.mockImplementation((_vars, opts) => opts?.onSuccess?.(makeJob()));
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Export all data' }));
    expect(screen.getByText(/Export queued/)).toBeInTheDocument();
  });

  it('reports a rejected export with the server detail on an assertive toast', () => {
    startExportMutate.mockImplementation((_vars, opts) =>
      opts?.onError?.({ response: { data: { detail: 'Another export is already running.' } } }),
    );
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Export all data' }));
    const toast = screen.getByRole('alert');
    expect(toast).toHaveTextContent('Another export is already running.');
    expect(toast).toHaveAttribute('aria-live', 'assertive');
  });

  it('falls back to the generic export message when the failure carries no detail', () => {
    startExportMutate.mockImplementation((_vars, opts) => opts?.onError?.({ nope: true }));
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Export all data' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Could not start the export.');
  });

  it('auto-dismisses a toast after its display window', () => {
    vi.useFakeTimers();
    startExportMutate.mockImplementation((_vars, opts) => opts?.onSuccess?.(makeJob()));
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Export all data' }));
    expect(screen.getByText(/Export queued/)).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(screen.queryByText(/Export queued/)).not.toBeInTheDocument();
  });
});

describe('WorkspaceDangerPage — archive download', () => {
  beforeEach(() => {
    exportJob = makeJob({ status: 'success', downloadUrl: 'https://example.test/a.tar.gz' });
  });

  it('downloads the ready archive and raises no error toast', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Download archive' }));

    await waitFor(() => expect(downloadMock).toHaveBeenCalledTimes(1));
    expect(downloadMock.mock.calls[0][0].id).toBe('job-1');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // The button is re-enabled once the transfer settles.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Download archive' })).toBeEnabled(),
    );
  });

  it('disables the button while the download is in flight', async () => {
    let release: () => void = () => undefined;
    downloadMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Download archive' }));

    const busy = await screen.findByRole('button', { name: 'Downloading…' });
    expect(busy).toBeDisabled();

    act(() => release());
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Download archive' })).toBeInTheDocument(),
    );
  });

  it('reports an expired link with the generic download message', async () => {
    downloadMock.mockRejectedValue(new Error('Request failed with status code 404'));
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Download archive' }));

    // An Error instance surfaces its own message.
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Request failed with status code 404',
    );
  });

  it('reports a non-Error download rejection with the fallback message', async () => {
    downloadMock.mockRejectedValue('kaboom');
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Download archive' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Download failed — the link may have expired.',
    );
  });
});

describe('WorkspaceDangerPage — transfer ownership', () => {
  it('disables the picker and says so when nobody is eligible', () => {
    members = [makeMember({ id: '3', name: 'Old Owner', role: 'Owner', roleValue: 400 })];
    renderPage();
    const select = screen.getByLabelText<HTMLSelectElement>('New owner');
    expect(select).toBeDisabled();
    expect(select).toHaveTextContent('No eligible members');
  });

  it('offers the picker with a prompt option when candidates exist', () => {
    renderPage();
    const select = screen.getByLabelText<HTMLSelectElement>('New owner');
    expect(select).toBeEnabled();
    expect(select).toHaveTextContent('Select a member…');
  });

  it('locks both controls while the transfer is in flight', () => {
    transferPending = true;
    renderPage();
    expect(screen.getByLabelText('New owner')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Transferring…' })).toBeDisabled();
  });

  it('confirms a successful transfer and clears the picker', () => {
    transferMutate.mockImplementation((_id, opts) => opts?.onSuccess?.());
    renderPage();
    fireEvent.change(screen.getByLabelText('New owner'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: /Transfer ownership/ }));

    expect(screen.getByText(/ownership transferred/i)).toBeInTheDocument();
    expect(screen.getByLabelText<HTMLSelectElement>('New owner').value).toBe('');
    // Selection cleared → the action re-gates.
    expect(screen.getByRole('button', { name: /Transfer ownership/ })).toBeDisabled();
  });

  it('surfaces the server detail when the transfer is rejected', () => {
    transferMutate.mockImplementation((_id, opts) =>
      opts?.onError?.({ response: { data: { detail: 'Only the owner may transfer.' } } }),
    );
    renderPage();
    fireEvent.change(screen.getByLabelText('New owner'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: /Transfer ownership/ }));

    expect(screen.getByRole('alert')).toHaveTextContent('Only the owner may transfer.');
    // A rejected transfer keeps the selection so the user can retry.
    expect(screen.getByLabelText<HTMLSelectElement>('New owner').value).toBe('2');
  });

  it('falls back to the Error message when no API detail is present', () => {
    transferMutate.mockImplementation((_id, opts) => opts?.onError?.(new Error('Network Error')));
    renderPage();
    fireEvent.change(screen.getByLabelText('New owner'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: /Transfer ownership/ }));

    expect(screen.getByRole('alert')).toHaveTextContent('Network Error');
  });

  it('falls back to the generic transfer message for an opaque rejection', () => {
    transferMutate.mockImplementation((_id, opts) => opts?.onError?.({ response: {} }));
    renderPage();
    fireEvent.change(screen.getByLabelText('New owner'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: /Transfer ownership/ }));

    expect(screen.getByRole('alert')).toHaveTextContent('Could not transfer ownership.');
  });

  it('does not fire a transfer when the selection is cleared back to the prompt', () => {
    renderPage();
    const select = screen.getByLabelText('New owner');
    fireEvent.change(select, { target: { value: '2' } });
    fireEvent.change(select, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /Transfer ownership/ }));

    expect(transferMutate).not.toHaveBeenCalled();
  });
});

describe('WorkspaceDangerPage — delete workspace', () => {
  it('holds the confirm field inert until the workspace name has loaded', () => {
    workspace = undefined;
    renderPage();
    const input = screen.getByLabelText<HTMLInputElement>(
      /Confirm delete by typing the workspace name/,
    );
    expect(input).toBeDisabled();
    expect(input).toHaveAttribute('placeholder', 'Loading…');
    expect(screen.getByRole('button', { name: 'Delete workspace permanently' })).toBeDisabled();
    expect(screen.getByText('…')).toBeInTheDocument();
  });

  it('prompts with the workspace name once it has loaded', () => {
    renderPage();
    const input = screen.getByLabelText<HTMLInputElement>(
      /Confirm delete by typing the workspace name/,
    );
    expect(input).toBeEnabled();
    expect(input).toHaveAttribute('placeholder', 'Type Acme to confirm');
  });

  it('trims surrounding whitespace out of the confirm phrase', () => {
    workspace = { name: '  Acme  ' };
    renderPage();
    const input = screen.getByLabelText(/Confirm delete by typing the workspace name/);
    fireEvent.change(input, { target: { value: 'Acme' } });
    expect(screen.getByRole('button', { name: 'Delete workspace permanently' })).toBeEnabled();
  });

  it('marks a partial confirm phrase as not-yet-matching', () => {
    renderPage();
    const input = screen.getByLabelText(/Confirm delete by typing the workspace name/);
    fireEvent.change(input, { target: { value: 'Acm' } });
    expect(input.className).toContain('border-semantic-critical');

    fireEvent.change(input, { target: { value: 'Acme' } });
    expect(input.className).not.toContain('border-semantic-critical');
  });

  it('shows the in-flight label and blocks a second delete', () => {
    deletePending = true;
    renderPage();
    const button = screen.getByRole('button', { name: 'Deleting…' });
    expect(button).toBeDisabled();
  });

  it('surfaces a rejected delete inline with the server detail', () => {
    deleteMutationError = { response: { data: { detail: 'Confirmation header mismatch.' } } };
    renderPage();
    expect(screen.getByRole('alert')).toHaveTextContent('Confirmation header mismatch.');
  });

  it('falls back to the generic delete message for an opaque failure', () => {
    deleteMutationError = { response: { data: {} } };
    renderPage();
    expect(screen.getByRole('alert')).toHaveTextContent('Delete failed.');
  });

  it('clears the session and bounces to login once the workspace is gone', async () => {
    deleteMutate.mockImplementation((_name, opts) => opts?.onSuccess?.());
    renderPage();
    fireEvent.change(screen.getByLabelText(/Confirm delete by typing the workspace name/), {
      target: { value: 'Acme' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Delete workspace permanently' }));

    expect(clearTokens).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Sign in to TruePPM')).toBeInTheDocument();
  });
});
