import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CascadeDeleteDialog } from './CascadeDeleteDialog';

/**
 * This dialog previously had no direct coverage — `RosterDetailPanel.test.tsx`
 * mocks it out entirely. It is one of the #3433 audit targets: `isLoading`
 * disables both Cancel and Confirm, so with no backdrop-dismiss handler and no
 * other focusable child, the trap's fallback seat is exercised on every
 * removal that has assignments to cascade.
 */
describe('CascadeDeleteDialog', () => {
  function renderDialog(isLoading = false) {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <CascadeDeleteDialog
        resourceName="Ana Reyes"
        assignmentCount={3}
        onConfirm={onConfirm}
        onCancel={onCancel}
        isLoading={isLoading}
      />,
    );
    return { onConfirm, onCancel };
  }

  it('renders as a dialog naming the resource and assignment count', () => {
    renderDialog();
    const dialog = screen.getByRole('dialog', { name: /Remove Ana Reyes\?/ });
    expect(dialog).toHaveTextContent('3 task assignments');
  });

  it('seats initial focus on Cancel, the safe default', () => {
    renderDialog();
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  // #3433: while isLoading both buttons are disabled — the trap's focusable
  // set is empty and the fallback seat is exercised. The seat must be the
  // panel (a visible, ring-able element), not the full-viewport scrim.
  it('seats the fallback focus on the panel — a visible ring, not the scrim — while loading', () => {
    renderDialog(true);
    const dialog = screen.getByRole('dialog');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Removing/ })).toBeDisabled();
    expect(dialog).toHaveFocus();
    expect(dialog.className).toMatch(/focus:ring-2/);
    // Shift+Tab from the seated fallback must not walk out of the dialog.
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(dialog).toHaveFocus();
  });

  it('routes Escape to onCancel', () => {
    const { onCancel } = renderDialog();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('invokes onConfirm from the destructive button', () => {
    const { onConfirm } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Remove and cascade' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
