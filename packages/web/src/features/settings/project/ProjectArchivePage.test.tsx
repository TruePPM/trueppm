import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi } from 'vitest';
import { ProjectArchivePage } from './ProjectArchivePage';

// The wired actions (archive / delete) are exercised elsewhere; this spec covers
// the not-yet-wired lifecycle placeholders, which must be disabled and carry the
// #967 tracking reference in their title (rule 122 / #669 — no dead buttons).
const mutation = { mutate: vi.fn(), isPending: false, error: null };

vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => 'p-1' }));
vi.mock('@/hooks/useProject', () => ({
  useProject: () => ({ data: { id: 'p-1', name: 'Atlas Migration', code: 'ATLAS', is_archived: false } }),
}));
vi.mock('@/hooks/useProjectMutations', () => ({
  useArchiveProject: () => mutation,
  useUnarchiveProject: () => mutation,
  useDeleteProject: () => mutation,
}));

function renderPage() {
  return render(
    <MemoryRouter>
      <ProjectArchivePage />
    </MemoryRouter>,
  );
}

describe('ProjectArchivePage — unwired lifecycle placeholders (#967)', () => {
  it('disables Transfer ownership with the #967 reference', () => {
    renderPage();
    const btn = screen.getByRole('button', { name: 'Transfer ownership…' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', expect.stringContaining('#967'));
  });

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
});
