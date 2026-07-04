import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UnsavedChangesDialog } from './UnsavedChangesDialog';

describe('UnsavedChangesDialog', () => {
  it('renders as an alertdialog with the discard prompt copy', () => {
    render(<UnsavedChangesDialog onKeepEditing={vi.fn()} onDiscard={vi.fn()} />);
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('Discard unsaved changes?');
    expect(dialog).toHaveTextContent("If you leave now, they'll be lost.");
  });

  it('defaults focus to the safe "Keep editing" action, not the destructive one', () => {
    render(<UnsavedChangesDialog onKeepEditing={vi.fn()} onDiscard={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Keep editing' })).toHaveFocus();
  });

  it('invokes onKeepEditing and onDiscard from the two buttons', async () => {
    const onKeepEditing = vi.fn();
    const onDiscard = vi.fn();
    const user = userEvent.setup();
    render(<UnsavedChangesDialog onKeepEditing={onKeepEditing} onDiscard={onDiscard} />);

    await user.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(onKeepEditing).toHaveBeenCalledTimes(1);
  });

  it('routes Escape to onKeepEditing (the safe path)', async () => {
    const onKeepEditing = vi.fn();
    const user = userEvent.setup();
    render(<UnsavedChangesDialog onKeepEditing={onKeepEditing} onDiscard={vi.fn()} />);

    await user.keyboard('{Escape}');
    expect(onKeepEditing).toHaveBeenCalled();
  });

  it('supports a bespoke body line', () => {
    render(
      <UnsavedChangesDialog onKeepEditing={vi.fn()} onDiscard={vi.fn()} body="Custom warning." />,
    );
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Custom warning.');
  });
});
