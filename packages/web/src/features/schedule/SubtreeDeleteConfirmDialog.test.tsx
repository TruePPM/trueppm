import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';
import { SubtreeDeleteConfirmDialog } from './SubtreeDeleteConfirmDialog';

describe('SubtreeDeleteConfirmDialog (#2029)', () => {
  it('names the row and its descendant count in the title', () => {
    renderWithProviders(
      <SubtreeDeleteConfirmDialog
        name="Phase 3"
        count={14}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText(/Delete “Phase 3” and its 14 subtasks\?/i)).toBeInTheDocument();
    // #2078: Undo faithfully restores the whole subtree — the copy says so.
    expect(
      screen.getByText(/the whole subtree, its dependencies, and assignments come back/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Delete 15 rows/i })).toBeInTheDocument();
  });

  it('singularizes copy for a single descendant', () => {
    renderWithProviders(
      <SubtreeDeleteConfirmDialog name="Phase 1" count={1} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByText(/its 1 subtask\?/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Delete 2 rows/i })).toBeInTheDocument();
  });

  it('calls onConfirm when the delete button is clicked', () => {
    const onConfirm = vi.fn();
    renderWithProviders(
      <SubtreeDeleteConfirmDialog name="Phase 3" count={5} onConfirm={onConfirm} onCancel={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Delete 6 rows/i }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('calls onCancel from the Cancel button and on Escape', () => {
    const onCancel = vi.fn();
    renderWithProviders(
      <SubtreeDeleteConfirmDialog name="Phase 3" count={5} onConfirm={vi.fn()} onCancel={onCancel} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});
