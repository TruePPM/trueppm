import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, it, expect, vi } from 'vitest';
import { ProgramArchivePage } from './ProgramArchivePage';

// Transfer sponsorship and Split program are both wired (issue 967); the only
// remaining disabled lifecycle placeholder is Export project (async bundle).
const mutation = { mutate: vi.fn(), isPending: false, error: null };
const transferMutate = vi.fn();
const transferMutation = { mutate: transferMutate, isPending: false, error: null };
const splitMutate = vi.fn();
const splitMutation = { mutate: splitMutate, isPending: false, error: null };

vi.mock('@/hooks/useProgram', () => ({
  useProgram: () => ({ data: { id: 'p-1', name: 'Phase 2 Modernization', code: 'PH2', is_closed: false } }),
}));
vi.mock('@/hooks/useProgramMutations', () => ({
  useCloseProgram: () => mutation,
  useReopenProgram: () => mutation,
  useDeleteProgram: () => mutation,
  useTransferSponsorship: () => transferMutation,
  useSplitProgram: () => splitMutation,
}));
vi.mock('@/hooks/useProgramProjects', () => ({
  useProgramProjects: () => ({
    data: [
      { id: 'proj-a', name: 'Apollo' },
      { id: 'proj-b', name: 'Beacon' },
    ],
    isLoading: false,
  }),
}));
vi.mock('@/hooks/useProjectMembers', () => ({
  useProjectMembers: () => ({ members: [], isLoading: false, error: null }),
}));
vi.mock('@/features/programs/hooks/useProgramMembers', () => ({
  useProgramMembers: () => ({
    data: [
      { user_detail: { id: 'u-2', username: 'bob.martin', email: 'bob@example.com' } },
      { user_detail: { id: 'u-3', username: 'carol.king', email: 'carol@example.com' } },
    ],
    isLoading: false,
  }),
}));

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/programs/p-1/settings/lifecycle']}>
      <Routes>
        <Route path="/programs/:programId/settings/lifecycle" element={<ProgramArchivePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ProgramArchivePage lifecycle (#967)', () => {
  it('Split program opens the dialog and POSTs the grouped splits', async () => {
    const user = userEvent.setup();
    splitMutate.mockClear();
    renderPage();

    await user.click(screen.getByRole('button', { name: 'Split program…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Split into sub-programs' });

    // Confirm is gated until at least one sub-program is named.
    const confirm = within(dialog).getByRole('button', { name: 'Split program' });
    expect(confirm).toBeDisabled();

    await user.type(within(dialog).getByLabelText('Sub-program 1 name'), 'Alpha');
    // Assign the first project to the new sub (its select option value is the
    // sub's stable localId, 'sub-0' for the first row).
    await user.selectOptions(within(dialog).getByLabelText('Assign project Apollo to'), 'sub-0');

    await waitFor(() => expect(confirm).toBeEnabled());
    await user.click(confirm);

    expect(splitMutate).toHaveBeenCalledWith(
      { programId: 'p-1', splits: [{ name: 'Alpha', project_ids: ['proj-a'] }] },
      expect.objectContaining({ onSuccess: expect.any(Function) as unknown }),
    );
  });

  it('keeps the wired Close action enabled', () => {
    renderPage();
    expect(screen.getByRole('button', { name: 'Close program…' })).toBeEnabled();
  });

  it('Transfer sponsorship opens the picker dialog and POSTs the chosen sponsor', async () => {
    const user = userEvent.setup();
    transferMutate.mockClear();
    renderPage();

    await user.click(screen.getByRole('button', { name: 'Transfer sponsorship…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Transfer sponsorship' });
    expect(dialog).toBeInTheDocument();

    const confirm = screen.getByRole('button', { name: /Confirm transfer/i });
    expect(confirm).toBeDisabled();

    // The dialog renders two pickers (new sponsor + optional new PM); pick the
    // first (sponsor) only — the lead stays unset and must not be sent.
    const assignTriggers = screen.getAllByRole('button', { name: 'Assign' });
    await user.click(assignTriggers[0]);
    await user.click(await screen.findByRole('option', { name: 'bob.martin' }));

    await waitFor(() => expect(confirm).toBeEnabled());
    await user.click(confirm);

    expect(transferMutate).toHaveBeenCalledWith(
      { programId: 'p-1', new_owner_user_id: 'u-2', new_lead_user_id: undefined },
      expect.objectContaining({ onSuccess: expect.any(Function) as unknown }),
    );
  });

  it('Transfer sponsorship dialog cancels without mutating', async () => {
    const user = userEvent.setup();
    transferMutate.mockClear();
    renderPage();

    await user.click(screen.getByRole('button', { name: 'Transfer sponsorship…' }));
    await screen.findByRole('dialog', { name: 'Transfer sponsorship' });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'Transfer sponsorship' }),
      ).not.toBeInTheDocument(),
    );
    expect(transferMutate).not.toHaveBeenCalled();
  });
});
