import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, it, expect, vi } from 'vitest';
import { ProgramArchivePage } from './ProgramArchivePage';

// Transfer sponsorship is now wired (issue 967); Split program remains a
// disabled placeholder carrying the #967 tracking reference (rule 122 / #669).
const mutation = { mutate: vi.fn(), isPending: false, error: null };
const transferMutate = vi.fn();
const transferMutation = { mutate: transferMutate, isPending: false, error: null };

vi.mock('@/hooks/useProgram', () => ({
  useProgram: () => ({ data: { id: 'p-1', name: 'Phase 2 Modernization', code: 'PH2', is_closed: false } }),
}));
vi.mock('@/hooks/useProgramMutations', () => ({
  useCloseProgram: () => mutation,
  useReopenProgram: () => mutation,
  useDeleteProgram: () => mutation,
  useTransferSponsorship: () => transferMutation,
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
  it('disables Split program with the #967 reference', () => {
    renderPage();
    const btn = screen.getByRole('button', { name: 'Split program…' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', expect.stringContaining('#967'));
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
