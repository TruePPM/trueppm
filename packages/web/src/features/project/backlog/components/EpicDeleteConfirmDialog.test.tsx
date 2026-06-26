import type { ComponentProps } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EpicDeleteConfirmDialog } from './EpicDeleteConfirmDialog';

function renderDialog(over: Partial<ComponentProps<typeof EpicDeleteConfirmDialog>> = {}) {
  const onCancel = vi.fn();
  const onConfirm = vi.fn();
  render(
    <EpicDeleteConfirmDialog
      epicName="Platform Core"
      storyCount={0}
      isPending={false}
      isError={false}
      onCancel={onCancel}
      onConfirm={onConfirm}
      {...over}
    />,
  );
  return { onCancel, onConfirm };
}

describe('EpicDeleteConfirmDialog (#1339)', () => {
  it('is an alertdialog naming the epic', () => {
    renderDialog();
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText(/“Platform Core” will be removed/)).toBeInTheDocument();
  });

  it('states "no stories" outcome when the epic is empty', () => {
    renderDialog({ storyCount: 0 });
    expect(screen.getByText(/This epic has no stories\./)).toBeInTheDocument();
  });

  it('uses singular copy for a one-story epic', () => {
    renderDialog({ storyCount: 1 });
    expect(
      screen.getByText(/This epic has 1 story\. It will move to Ungrouped — it is not deleted\./),
    ).toBeInTheDocument();
  });

  it('states the affected count and the ungroup-not-delete outcome for many stories', () => {
    renderDialog({ storyCount: 6 });
    expect(
      screen.getByText(
        /This epic has 6 stories\. They will move to Ungrouped — they are not deleted\./,
      ),
    ).toBeInTheDocument();
  });

  it('focuses Cancel on mount (never the destructive button)', () => {
    renderDialog();
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('shows the confirm button as "Delete epic" and switches to "Deleting…" while pending', () => {
    const { rerender } = render(
      <EpicDeleteConfirmDialog
        epicName="X"
        storyCount={0}
        isPending={false}
        isError={false}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Delete epic' })).toBeEnabled();
    rerender(
      <EpicDeleteConfirmDialog
        epicName="X"
        storyCount={0}
        isPending
        isError={false}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    const confirm = screen.getByRole('button', { name: 'Deleting…' });
    expect(confirm).toBeDisabled();
  });

  it('surfaces an inline retry alert on error', () => {
    renderDialog({ isError: true });
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't delete — try again.");
  });

  it('calls onConfirm / onCancel from the buttons', async () => {
    const user = userEvent.setup();
    const { onCancel, onConfirm } = renderDialog({ storyCount: 2 });
    await user.click(screen.getByRole('button', { name: 'Delete epic' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('cancels on Escape', async () => {
    const user = userEvent.setup();
    const { onCancel } = renderDialog();
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
