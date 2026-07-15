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

  describe('three-verb swap form (#1978)', () => {
    it('renders the Save & continue verb and custom title/labels when onSaveAndContinue is given', () => {
      render(
        <UnsavedChangesDialog
          title="Unsaved changes"
          body='Open "Steel erection" anyway?'
          onKeepEditing={vi.fn()}
          onDiscard={vi.fn()}
          discardLabel="Discard & open"
          onSaveAndContinue={vi.fn()}
          saveAndContinueLabel="Save & open"
        />,
      );
      const dialog = screen.getByRole('alertdialog');
      expect(dialog).toHaveTextContent('Unsaved changes');
      expect(screen.getByRole('button', { name: 'Keep editing' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Discard & open' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Save & open' })).toBeInTheDocument();
    });

    it('focuses the primary Save & continue verb (intent-preserving default), not Keep editing', () => {
      render(
        <UnsavedChangesDialog
          onKeepEditing={vi.fn()}
          onDiscard={vi.fn()}
          onSaveAndContinue={vi.fn()}
          saveAndContinueLabel="Save & open"
        />,
      );
      expect(screen.getByRole('button', { name: 'Save & open' })).toHaveFocus();
    });

    it('invokes onSaveAndContinue from the primary button', async () => {
      const onSaveAndContinue = vi.fn();
      const user = userEvent.setup();
      render(
        <UnsavedChangesDialog
          onKeepEditing={vi.fn()}
          onDiscard={vi.fn()}
          onSaveAndContinue={onSaveAndContinue}
          saveAndContinueLabel="Save & open"
        />,
      );
      await user.click(screen.getByRole('button', { name: 'Save & open' }));
      expect(onSaveAndContinue).toHaveBeenCalledTimes(1);
    });

    it('disables the verbs and shows a saving label while saving', () => {
      render(
        <UnsavedChangesDialog
          onKeepEditing={vi.fn()}
          onDiscard={vi.fn()}
          onSaveAndContinue={vi.fn()}
          saveAndContinueLabel="Save & open"
          saving
        />,
      );
      expect(screen.getByRole('button', { name: 'Keep editing' })).toBeDisabled();
      expect(screen.getByRole('button', { name: /Saving/ })).toBeDisabled();
    });

    it('announces a save error via role=alert and keeps the dialog open', () => {
      render(
        <UnsavedChangesDialog
          onKeepEditing={vi.fn()}
          onDiscard={vi.fn()}
          onSaveAndContinue={vi.fn()}
          error="Couldn't save — try again"
        />,
      );
      expect(screen.getByRole('alert')).toHaveTextContent("Couldn't save — try again");
      expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    });
  });
});
