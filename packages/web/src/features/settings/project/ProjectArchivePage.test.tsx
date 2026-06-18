import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi } from 'vitest';
import { ProjectArchivePage } from './ProjectArchivePage';

// Transfer ownership is now wired (issue 967); Export project remains a
// disabled placeholder carrying the #967 tracking reference (rule 122 / #669).
const mutation = { mutate: vi.fn(), isPending: false, error: null };
const transferMutate = vi.fn();
const transferMutation = { mutate: transferMutate, isPending: false, error: null };

vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => 'p-1' }));
vi.mock('@/hooks/useProject', () => ({
  useProject: () => ({ data: { id: 'p-1', name: 'Atlas Migration', code: 'ATLAS', is_archived: false } }),
}));
vi.mock('@/hooks/useProjectMutations', () => ({
  useArchiveProject: () => mutation,
  useUnarchiveProject: () => mutation,
  useDeleteProject: () => mutation,
  useTransferProject: () => transferMutation,
}));
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

describe('ProjectArchivePage lifecycle (#967)', () => {
  it('disables Export project with the #967 reference', () => {
    renderPage();
    const btn = screen.getByRole('button', { name: 'Generate export…' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', expect.stringContaining('#967'));
  });

  it('keeps the wired Archive action enabled', () => {
    renderPage();
    expect(screen.getByRole('button', { name: /Archive Atlas Migration/i })).toBeEnabled();
  });

  it('Transfer ownership opens the picker dialog and POSTs the chosen member', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: 'Transfer ownership…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Transfer ownership' });
    expect(dialog).toBeInTheDocument();

    // Confirm is disabled until a new owner is picked.
    const confirm = screen.getByRole('button', { name: /Confirm transfer/i });
    expect(confirm).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Assign' }));
    await user.click(await screen.findByRole('option', { name: 'bob.martin' }));

    await waitFor(() => expect(confirm).toBeEnabled());
    await user.click(confirm);

    expect(transferMutate).toHaveBeenCalledWith(
      { new_owner_user_id: 'u-2' },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it('Transfer ownership dialog cancels without mutating', async () => {
    const user = userEvent.setup();
    transferMutate.mockClear();
    renderPage();

    await user.click(screen.getByRole('button', { name: 'Transfer ownership…' }));
    await screen.findByRole('dialog', { name: 'Transfer ownership' });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Transfer ownership' })).not.toBeInTheDocument(),
    );
    expect(transferMutate).not.toHaveBeenCalled();
  });
});
