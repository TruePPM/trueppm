import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DeleteConfirmDialog, describeCascade } from './DeleteConfirmDialog';

describe('describeCascade', () => {
  it('returns an empty string when every count is zero', () => {
    expect(
      describeCascade([
        { count: 0, singular: 'subtask', plural: 'subtasks' },
        { count: 0, singular: 'dependency link', plural: 'dependency links' },
      ]),
    ).toBe('');
  });

  it('uses the singular noun for a count of one', () => {
    expect(describeCascade([{ count: 1, singular: 'subtask', plural: 'subtasks' }])).toBe(
      '1 subtask',
    );
  });

  it('pluralizes and drops zero-count clauses', () => {
    expect(
      describeCascade([
        { count: 3, singular: 'subtask', plural: 'subtasks' },
        { count: 0, singular: 'dependency link', plural: 'dependency links' },
      ]),
    ).toBe('3 subtasks');
  });

  it('joins two non-zero clauses with "and"', () => {
    expect(
      describeCascade([
        { count: 2, singular: 'subtask', plural: 'subtasks' },
        { count: 1, singular: 'dependency link', plural: 'dependency links' },
      ]),
    ).toBe('2 subtasks and 1 dependency link');
  });

  it('Oxford-joins three or more clauses', () => {
    expect(
      describeCascade([
        { count: 2, singular: 'subtask', plural: 'subtasks' },
        { count: 4, singular: 'dependency link', plural: 'dependency links' },
        { count: 1, singular: 'comment', plural: 'comments' },
      ]),
    ).toBe('2 subtasks, 4 dependency links, and 1 comment');
  });
});

describe('DeleteConfirmDialog', () => {
  it('renders the task name in the body and the alertdialog role', () => {
    render(
      <DeleteConfirmDialog
        taskName="My Task"
        isPending={false}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText(/“My Task”/)).toBeInTheDocument();
  });

  it('states the plain single-item copy when nothing else cascades', () => {
    render(
      <DeleteConfirmDialog
        taskName="Solo"
        isPending={false}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(
      screen.getByText(/will be permanently removed\. This can’t be undone\./),
    ).toBeInTheDocument();
    expect(screen.queryByText(/along with its/)).not.toBeInTheDocument();
  });

  it('quantifies subtasks and dependency links in the body copy', () => {
    render(
      <DeleteConfirmDialog
        taskName="Parent"
        isPending={false}
        subtaskCount={3}
        dependencyCount={1}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(
      screen.getByText(/along with its 3 subtasks and 1 dependency link\./),
    ).toBeInTheDocument();
  });

  it('hides the subtasks clause when the count is zero', () => {
    render(
      <DeleteConfirmDialog
        taskName="Leaf"
        isPending={false}
        subtaskCount={0}
        dependencyCount={2}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByText(/along with its 2 dependency links\./)).toBeInTheDocument();
    expect(screen.queryByText(/subtask/)).not.toBeInTheDocument();
  });

  it('autofocuses Cancel — destructive actions never autofocus the destructive button', () => {
    render(
      <DeleteConfirmDialog
        taskName="x"
        isPending={false}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('shows "Deleting…" and disables both buttons while a delete is pending', () => {
    render(
      <DeleteConfirmDialog
        taskName="x"
        isPending
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Deleting…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });

  it('calls onCancel when the Cancel button is clicked', () => {
    const onCancel = vi.fn();
    render(
      <DeleteConfirmDialog
        taskName="x"
        isPending={false}
        onCancel={onCancel}
        onConfirm={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('calls onConfirm when Delete is clicked', () => {
    const onConfirm = vi.fn();
    render(
      <DeleteConfirmDialog
        taskName="x"
        isPending={false}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onConfirm).toHaveBeenCalled();
  });

  it('traps Tab inside the alertdialog — Tab from Delete wraps to Cancel (#1776)', () => {
    render(
      <DeleteConfirmDialog
        taskName="x"
        isPending={false}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    // The parent TaskFormModal yields its trap while this dialog is open, so
    // without an own trap Tab would escape into the background form.
    screen.getByRole('button', { name: 'Delete' }).focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('traps Shift+Tab inside the alertdialog — wraps from Cancel to Delete (#1776)', () => {
    render(
      <DeleteConfirmDialog
        taskName="x"
        isPending={false}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    screen.getByRole('button', { name: 'Cancel' }).focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveFocus();
  });

  it('calls onCancel when Escape is pressed at the document level', () => {
    const onCancel = vi.fn();
    render(
      <DeleteConfirmDialog
        taskName="x"
        isPending={false}
        onCancel={onCancel}
        onConfirm={vi.fn()}
      />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalled();
  });

  it('calls onCancel on backdrop pointer-down (clicking outside the inner card)', () => {
    const onCancel = vi.fn();
    render(
      <DeleteConfirmDialog
        taskName="x"
        isPending={false}
        onCancel={onCancel}
        onConfirm={vi.fn()}
      />,
    );
    const backdrop = screen.getByRole('alertdialog');
    // Pointer-down whose target equals currentTarget = on the backdrop itself.
    fireEvent.pointerDown(backdrop, { target: backdrop });
    expect(onCancel).toHaveBeenCalled();
  });

  it('does not close on pointer-down inside the inner card', () => {
    const onCancel = vi.fn();
    render(
      <DeleteConfirmDialog
        taskName="x"
        isPending={false}
        onCancel={onCancel}
        onConfirm={vi.fn()}
      />,
    );
    fireEvent.pointerDown(screen.getByText('Delete this task?'));
    expect(onCancel).not.toHaveBeenCalled();
  });
});
