import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProjectArchivePage } from './ProjectArchivePage';

// ---------------------------------------------------------------------------
// Mutable mock state (reset in beforeEach). A single hoisted object lets each
// test flip project archive state, mutation pending/error, and the export job
// status without re-declaring the module mocks.
// ---------------------------------------------------------------------------

type Mutation = { mutate: ReturnType<typeof vi.fn>; isPending: boolean; error: unknown };

const h = vi.hoisted(() => {
  const mk = () => ({ mutate: vi.fn(), isPending: false, error: null as unknown });
  return {
    project: {
      id: 'p-1',
      name: 'Atlas Migration',
      code: 'ATLAS',
      is_archived: false,
    } as { id: string; name: string; code?: string | null; is_archived: boolean },
    archive: mk(),
    unarchive: mk(),
    remove: mk(),
    transfer: mk(),
    exportSeed: mk(),
    startBundle: mk(),
    exportJob: { data: undefined as unknown },
    downloadProjectExport: vi.fn((..._args: unknown[]) => Promise.resolve()),
    navigate: vi.fn(),
    toast: { action: vi.fn(), success: vi.fn(), error: vi.fn() },
    apiPost: vi.fn((..._args: unknown[]) => Promise.resolve()),
    invalidateQueries: vi.fn((..._args: unknown[]) => undefined),
  };
});

vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => 'p-1' }));
vi.mock('@/hooks/useProject', () => ({ useProject: () => ({ data: h.project }) }));
vi.mock('@/hooks/useProjectMutations', () => ({
  useArchiveProject: () => h.archive as Mutation,
  useUnarchiveProject: () => h.unarchive as Mutation,
  useDeleteProject: () => h.remove as Mutation,
  useTransferProject: () => h.transfer as Mutation,
}));
vi.mock('@/hooks/useProgramSeedIo', () => ({ useExportProjectSeed: () => h.exportSeed as Mutation }));
vi.mock('../hooks/useProjectExport', () => ({
  useStartProjectExport: () => h.startBundle as Mutation,
  useProjectExportJob: () => h.exportJob,
  downloadProjectExport: (...args: unknown[]) => h.downloadProjectExport(...args),
}));
vi.mock('@/components/Toast', () => ({ toast: h.toast }));
vi.mock('@/api/client', () => ({ apiClient: { post: (...a: unknown[]) => h.apiPost(...a) } }));
vi.mock('@/lib/queryClient', () => ({
  queryClient: { invalidateQueries: (...a: unknown[]) => h.invalidateQueries(...a) },
}));
vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return { ...actual, useNavigate: () => h.navigate };
});
// TransferOwnershipDialog reads the member lists.
vi.mock('@/hooks/useProjectMembers', () => ({
  useProjectMembers: () => ({
    members: [
      { id: 'u-2', username: 'bob.martin', role: 100 },
      { id: 'u-3', username: 'carol.king', role: 100 },
    ],
    isLoading: false,
    error: null,
  }),
}));
vi.mock('@/features/programs/hooks/useProgramMembers', () => ({
  useProgramMembers: () => ({ data: [], isLoading: false }),
}));

function renderPage() {
  return render(
    <MemoryRouter>
      <ProjectArchivePage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.project = { id: 'p-1', name: 'Atlas Migration', code: 'ATLAS', is_archived: false };
  for (const m of [h.archive, h.unarchive, h.remove, h.transfer, h.exportSeed, h.startBundle]) {
    m.isPending = false;
    m.error = null;
    m.mutate.mockReset();
  }
  h.exportJob = { data: undefined };
  h.downloadProjectExport.mockReset();
  h.downloadProjectExport.mockResolvedValue(undefined);
  h.apiPost.mockReset();
  h.apiPost.mockResolvedValue(undefined);
});

// ===========================================================================
// Existing coverage (#967) — export / archive / transfer
// ===========================================================================

describe('ProjectArchivePage lifecycle (#967)', () => {
  it('Export project triggers a JSON seed download for the project code', async () => {
    const user = userEvent.setup();
    renderPage();
    const btn = screen.getByRole('button', { name: 'Export project…' });
    expect(btn).toBeEnabled();
    await user.click(btn);
    expect(h.exportSeed.mutate).toHaveBeenCalledWith({ projectId: 'p-1', code: 'ATLAS' });
  });

  it('keeps the wired Archive action enabled', () => {
    renderPage();
    expect(screen.getByRole('button', { name: /Archive Atlas Migration/i })).toBeEnabled();
  });

  it('renders the Transfer ownership (warning) card with adaptive dark-mode tokens (#1619)', () => {
    renderPage();
    const heading = screen.getByRole('heading', { name: 'Transfer ownership' });
    const card = heading.closest('div.rounded-card');
    expect(card).not.toBeNull();
    expect(card!.className).toContain('bg-semantic-warning-bg');
    expect(card!.className).toContain('border-semantic-warning/70');
    expect(card!.className).not.toContain('bg-brand-accent-light');
  });

  it('Transfer ownership opens the picker dialog and POSTs the chosen member', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Transfer ownership…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Transfer ownership' });
    expect(dialog).toBeInTheDocument();

    const confirm = screen.getByRole('button', { name: /Confirm transfer/i });
    expect(confirm).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Assign' }));
    await user.click(await screen.findByRole('option', { name: 'bob.martin' }));

    await waitFor(() => expect(confirm).toBeEnabled());
    await user.click(confirm);

    expect(h.transfer.mutate).toHaveBeenCalledWith(
      { new_owner_user_id: 'u-2' },
      expect.objectContaining({ onSuccess: expect.any(Function) as unknown }),
    );
  });

  it('Transfer ownership dialog cancels without mutating', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Transfer ownership…' }));
    await screen.findByRole('dialog', { name: 'Transfer ownership' });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Transfer ownership' })).not.toBeInTheDocument(),
    );
    expect(h.transfer.mutate).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Archive / unarchive toggle
// ===========================================================================

describe('ProjectArchivePage archive toggle', () => {
  it('archives an active project when the archive button is clicked', async () => {
    const user = userEvent.setup();
    renderPage();
    expect(screen.getByRole('heading', { name: 'Archive project' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Archive Atlas Migration…' }));
    expect(h.archive.mutate).toHaveBeenCalledWith(undefined);
    expect(h.unarchive.mutate).not.toHaveBeenCalled();
  });

  it('shows the unarchive affordance and unarchives an archived project', async () => {
    const user = userEvent.setup();
    h.project = { ...h.project, is_archived: true };
    renderPage();
    expect(screen.getByRole('heading', { name: 'Unarchive project' })).toBeInTheDocument();
    // Copy reflects the restore path, not the freeze path
    expect(
      screen.getByText(/Restore writes to this project/i),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Unarchive Atlas Migration…' }));
    expect(h.unarchive.mutate).toHaveBeenCalledWith(undefined);
    expect(h.archive.mutate).not.toHaveBeenCalled();
  });

  it('surfaces an archive mutation error inside the archive card', () => {
    h.archive.error = new Error('Archive failed on server');
    renderPage();
    const alerts = screen.getAllByRole('alert').map((a) => a.textContent);
    expect(alerts).toContain('Archive failed on server');
  });

  it('surfaces the unarchive error when the project is archived', () => {
    h.project = { ...h.project, is_archived: true };
    h.unarchive.error = new Error('Unarchive failed');
    renderPage();
    const alerts = screen.getAllByRole('alert').map((a) => a.textContent);
    expect(alerts).toContain('Unarchive failed');
  });

  it('shows a busy label while archiving is pending', () => {
    h.archive.isPending = true;
    renderPage();
    // The archive card button shows the working state
    const heading = screen.getByRole('heading', { name: 'Archive project' });
    const card = heading.closest('div.rounded-card')!;
    expect(card.querySelector('button')!.textContent).toBe('Working…');
  });
});

// ===========================================================================
// Type-to-confirm permanent delete
// ===========================================================================

describe('ProjectArchivePage permanent delete', () => {
  it('keeps the delete button disabled until the exact project code is typed', async () => {
    const user = userEvent.setup();
    renderPage();
    const del = screen.getByRole('button', { name: 'Delete project permanently' });
    expect(del).toBeDisabled();

    const input = screen.getByLabelText('Confirm delete by typing the project code or name');
    await user.type(input, 'ATLA'); // partial → still locked
    expect(del).toBeDisabled();

    await user.type(input, 'S'); // now "ATLAS"
    expect(del).toBeEnabled();
  });

  it('archives first, then force-deletes and navigates home for an active project', async () => {
    const user = userEvent.setup();
    // archive.mutate should invoke its onSuccess so the chained delete runs
    h.archive.mutate.mockImplementation((_v: unknown, opts?: { onSuccess?: () => void }) =>
      opts?.onSuccess?.(),
    );
    h.remove.mutate.mockImplementation(
      (_v: unknown, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.(),
    );
    renderPage();

    await user.type(
      screen.getByLabelText('Confirm delete by typing the project code or name'),
      'ATLAS',
    );
    await user.click(screen.getByRole('button', { name: 'Delete project permanently' }));

    expect(h.archive.mutate).toHaveBeenCalled();
    expect(h.remove.mutate).toHaveBeenCalledWith(
      { force: true },
      expect.objectContaining({ onSuccess: expect.any(Function) as unknown }),
    );
    expect(h.navigate).toHaveBeenCalledWith('/', { replace: true });
  });

  it('deletes directly (no archive) when the project is already archived', async () => {
    const user = userEvent.setup();
    h.project = { ...h.project, is_archived: true };
    h.remove.mutate.mockImplementation(
      (_v: unknown, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.(),
    );
    renderPage();

    await user.type(
      screen.getByLabelText('Confirm delete by typing the project code or name'),
      'ATLAS',
    );
    await user.click(screen.getByRole('button', { name: 'Delete project permanently' }));

    expect(h.archive.mutate).not.toHaveBeenCalled();
    expect(h.remove.mutate).toHaveBeenCalledWith(
      { force: true },
      expect.objectContaining({ onSuccess: expect.any(Function) as unknown }),
    );
    expect(h.navigate).toHaveBeenCalledWith('/', { replace: true });
  });

  it('falls back to the project name for the confirm phrase when there is no code', async () => {
    const user = userEvent.setup();
    h.project = { id: 'p-1', name: 'Atlas Migration', code: null, is_archived: false };
    renderPage();
    // Prompt asks for the name, and the name unlocks the button
    expect(screen.getByText(/type the project name/i)).toBeInTheDocument();
    const del = screen.getByRole('button', { name: 'Delete project permanently' });
    await user.type(
      screen.getByLabelText('Confirm delete by typing the project code or name'),
      'Atlas Migration',
    );
    expect(del).toBeEnabled();
  });

  it('renders a delete mutation error', () => {
    h.remove.error = new Error('Delete blocked: linked dependencies');
    renderPage();
    expect(screen.getByText('Delete blocked: linked dependencies')).toBeInTheDocument();
  });
});

// ===========================================================================
// Move to Trash (soft delete + Undo)
// ===========================================================================

describe('ProjectArchivePage move to Trash', () => {
  it('soft-deletes, fires an Undo toast, and navigates home', async () => {
    const user = userEvent.setup();
    h.remove.mutate.mockImplementation(
      (_v: unknown, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.(),
    );
    renderPage();

    await user.click(screen.getByRole('button', { name: 'Move to Trash…' }));

    expect(h.remove.mutate).toHaveBeenCalledWith(
      { force: false },
      expect.objectContaining({ onSuccess: expect.any(Function) as unknown }),
    );
    expect(h.toast.action).toHaveBeenCalledWith(
      '"Atlas Migration" moved to Trash',
      expect.objectContaining({ label: 'Undo', ariaLabel: 'Undo — restore Atlas Migration' }),
    );
    expect(h.navigate).toHaveBeenCalledWith('/', { replace: true });
  });

  it('restores via the Undo action, invalidates caches, and navigates to the project', async () => {
    const user = userEvent.setup();
    h.remove.mutate.mockImplementation(
      (_v: unknown, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.(),
    );
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Move to Trash…' }));

    // Pull the Undo closure out of the toast and invoke it
    const action = h.toast.action.mock.calls[0][1] as { onClick: () => void };
    action.onClick();

    await waitFor(() => expect(h.apiPost).toHaveBeenCalledWith('/projects/p-1/restore/'));
    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith('"Atlas Migration" restored'));
    expect(h.invalidateQueries).toHaveBeenCalledTimes(3);
    expect(h.navigate).toHaveBeenCalledWith('/projects/p-1');
  });

  it('shows an error toast when the Undo restore call fails', async () => {
    const user = userEvent.setup();
    h.remove.mutate.mockImplementation(
      (_v: unknown, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.(),
    );
    h.apiPost.mockRejectedValue(new Error('restore failed'));
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Move to Trash…' }));

    const action = h.toast.action.mock.calls[0][1] as { onClick: () => void };
    action.onClick();

    await waitFor(() =>
      expect(h.toast.error).toHaveBeenCalledWith('Could not restore — open Trash to try again'),
    );
    expect(h.toast.success).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Per-card docs links (#2266)
// ===========================================================================

describe('ProjectArchivePage docs links (#2266)', () => {
  it('renders a per-card "Learn more" docs link on each lifecycle card', () => {
    renderPage();
    const hrefs = screen
      .getAllByRole('link', { name: /Learn more/i })
      .map((l) => l.getAttribute('href') ?? '');
    expect(hrefs).toHaveLength(6);
    expect(hrefs.some((h) => h.includes('administration/project-settings/#lifecycle'))).toBe(true);
    expect(hrefs.some((h) => h.includes('administration/rbac'))).toBe(true);
    expect(hrefs.some((h) => h.includes('administration/data-export/#export-a-project'))).toBe(true);
    expect(
      hrefs.some((h) => h.includes('administration/data-export/#export-a-project-bundle-async')),
    ).toBe(true);
    expect(hrefs.some((h) => h.includes('administration/retention'))).toBe(true);
  });
});

// ===========================================================================
// Async Export bundle card (ADR-0219)
// ===========================================================================

describe('ProjectArchivePage export bundle', () => {
  it('queues a bundle build and tracks the returned job id', async () => {
    const user = userEvent.setup();
    h.startBundle.mutate.mockImplementation(
      (_v: unknown, opts?: { onSuccess?: (j: { id: string }) => void }) =>
        opts?.onSuccess?.({ id: 'job-9' }),
    );
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Export bundle…' }));
    expect(h.startBundle.mutate).toHaveBeenCalled();
  });

  it('shows the building status and disables the button while the job runs', () => {
    h.exportJob = { data: { id: 'job-9', status: 'running' } };
    renderPage();
    expect(screen.getByRole('status')).toHaveTextContent('Building bundle…');
    // The bundle card action shows the busy label
    const heading = screen.getByRole('heading', { name: 'Export bundle' });
    const card = heading.closest('div.rounded-card')!;
    const actionBtn = card.querySelector('button')!;
    expect(actionBtn).toBeDisabled();
    expect(actionBtn.textContent).toBe('Working…');
  });

  it('shows the queued status label for a pending job', () => {
    h.exportJob = { data: { id: 'job-9', status: 'pending' } };
    renderPage();
    expect(screen.getByRole('status')).toHaveTextContent('Queued…');
  });

  it('offers Download and Rebuild once the bundle is ready and downloads it', async () => {
    const user = userEvent.setup();
    h.exportJob = { data: { id: 'job-9', status: 'success', downloadUrl: '/dl/job-9' } };
    renderPage();

    const download = screen.getByRole('button', { name: 'Download bundle' });
    await user.click(download);
    expect(h.downloadProjectExport).toHaveBeenCalledWith(
      'p-1',
      expect.objectContaining({ id: 'job-9' }),
      'ATLAS',
    );
    // Rebuild re-queues via the start mutation
    await user.click(screen.getByRole('button', { name: 'Rebuild' }));
    expect(h.startBundle.mutate).toHaveBeenCalled();
  });

  it('surfaces a download error when the signed link has expired', async () => {
    const user = userEvent.setup();
    h.exportJob = { data: { id: 'job-9', status: 'success', downloadUrl: '/dl/job-9' } };
    h.downloadProjectExport.mockRejectedValue(new Error('gone'));
    renderPage();

    await user.click(screen.getByRole('button', { name: 'Download bundle' }));
    expect(
      await screen.findByText(/Download failed — the link may have expired/i),
    ).toBeInTheDocument();
  });

  it('renders a failed-job error with the server detail', () => {
    h.exportJob = { data: { id: 'job-9', status: 'failed', errorDetail: 'disk full' } };
    renderPage();
    expect(screen.getByText(/Export failed: disk full\. Try again\./i)).toBeInTheDocument();
  });

  it('renders the start-mutation error when queuing the bundle fails', () => {
    Object.assign(h.startBundle, { error: new Error('queue rejected') });
    renderPage();
    const heading = screen.getByRole('heading', { name: 'Export bundle' });
    const card = heading.closest('div.rounded-card')!;
    expect(card.textContent).toContain('queue rejected');
  });
});
