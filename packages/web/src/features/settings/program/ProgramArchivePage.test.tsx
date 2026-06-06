import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, it, expect, vi } from 'vitest';
import { ProgramArchivePage } from './ProgramArchivePage';

// The wired actions (close / delete) are exercised elsewhere; this spec covers
// the not-yet-wired lifecycle placeholders, which must be disabled and carry the
// #967 tracking reference in their title (rule 122 / #669 — no dead buttons).
const mutation = { mutate: vi.fn(), isPending: false, error: null };

vi.mock('@/hooks/useProgram', () => ({
  useProgram: () => ({ data: { id: 'p-1', name: 'Phase 2 Modernization', code: 'PH2', is_closed: false } }),
}));
vi.mock('@/hooks/useProgramMutations', () => ({
  useCloseProgram: () => mutation,
  useReopenProgram: () => mutation,
  useDeleteProgram: () => mutation,
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

describe('ProgramArchivePage — unwired lifecycle placeholders (#967)', () => {
  it('disables Transfer sponsorship with the #967 reference', () => {
    renderPage();
    const btn = screen.getByRole('button', { name: 'Transfer sponsorship…' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', expect.stringContaining('#967'));
  });

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
});
