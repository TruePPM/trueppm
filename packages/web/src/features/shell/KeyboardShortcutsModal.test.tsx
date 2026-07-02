import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { KeyboardShortcutsModal } from './KeyboardShortcutsModal';

describe('KeyboardShortcutsModal', () => {
  it('focuses the close button on open', () => {
    render(<KeyboardShortcutsModal onClose={() => {}} />);
    expect(screen.getByRole('button', { name: /close keyboard shortcuts/i })).toHaveFocus();
  });

  it('traps focus inside the dialog — Tab cannot escape behind the scrim', () => {
    render(<KeyboardShortcutsModal onClose={() => {}} />);
    const button = screen.getByRole('button', { name: /close keyboard shortcuts/i });
    button.focus();
    expect(button).toHaveFocus();
    // The close button is the sole focusable, so the trap must cancel Tab /
    // Shift+Tab at the boundary (fireEvent returns false when the event is
    // defaultPrevented) and keep focus contained.
    expect(fireEvent.keyDown(document, { key: 'Tab' })).toBe(false);
    expect(button).toHaveFocus();
    expect(fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })).toBe(false);
    expect(button).toHaveFocus();
  });

  it('calls onClose when Escape is pressed', () => {
    const onClose = vi.fn();
    render(<KeyboardShortcutsModal onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('calls onClose when the close button is clicked', () => {
    const onClose = vi.fn();
    render(<KeyboardShortcutsModal onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /close keyboard shortcuts/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
