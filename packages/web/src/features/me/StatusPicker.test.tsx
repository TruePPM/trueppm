import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';
import { StatusPicker } from './StatusPicker';

describe('StatusPicker', () => {
  it('renders the four status options with the current one marked selected', () => {
    renderWithProviders(
      <StatusPicker
        taskName="Wire the avionics loom"
        current="IN_PROGRESS"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    const inProgress = screen.getByRole('option', { name: 'In progress' });
    expect(inProgress).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('button', { name: 'In progress' })).toBeDisabled();
  });

  it('calls onSelect with the clicked status', () => {
    const onSelect = vi.fn();
    renderWithProviders(
      <StatusPicker
        taskName="Wire the avionics loom"
        current="NOT_STARTED"
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Complete' }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('COMPLETE');
  });

  it('calls onClose on Escape keydown (useFocusTrap)', () => {
    const onClose = vi.fn();
    renderWithProviders(
      <StatusPicker
        taskName="Wire the avionics loom"
        current="NOT_STARTED"
        onSelect={vi.fn()}
        onClose={onClose}
      />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('calls onClose on pointer-down outside the picker', () => {
    const onClose = vi.fn();
    renderWithProviders(
      <div>
        <button type="button">Outside trigger</button>
        <StatusPicker
          taskName="Wire the avionics loom"
          current="NOT_STARTED"
          onSelect={vi.fn()}
          onClose={onClose}
        />
      </div>,
    );
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside trigger' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('does not close on pointer-down inside the picker', () => {
    const onClose = vi.fn();
    renderWithProviders(
      <StatusPicker
        taskName="Wire the avionics loom"
        current="NOT_STARTED"
        onSelect={vi.fn()}
        onClose={onClose}
      />,
    );
    fireEvent.pointerDown(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('traps Tab: Shift+Tab from the first option wraps to Cancel', () => {
    renderWithProviders(
      <StatusPicker
        taskName="Wire the avionics loom"
        current="IN_PROGRESS"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    // "In progress" is disabled (it's `current`), so the first enabled
    // option — "Not started" — is the trap's real first focusable.
    const firstOption = screen.getByRole('button', { name: 'Not started' });
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    firstOption.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(cancel).toHaveFocus();
  });
});
