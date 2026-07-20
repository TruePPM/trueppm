import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
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

  it('lists the real, wired shortcuts (not a "coming soon" placeholder)', () => {
    render(<KeyboardShortcutsModal onClose={vi.fn()} />);
    // The dead-end placeholder must be gone (#1556).
    expect(screen.queryByText(/coming soon/i)).toBeNull();
    // Section groupings — including the new Editing group (#2058).
    expect(screen.getByRole('heading', { name: 'Global' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Command palette' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Editing' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Board' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Sprints' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Schedule (Gantt)' })).toBeInTheDocument();
    // The rebound sprint create shortcut is documented (#2162).
    expect(screen.getByText('Add a task to the active sprint')).toBeInTheDocument();
    // A representative binding from each group.
    expect(screen.getByText('Open the command palette')).toBeInTheDocument();
    expect(screen.getByText('Show or hide the sidebar')).toBeInTheDocument();
    expect(screen.getByText('Run the selected action')).toBeInTheDocument();
    expect(screen.getByText('Move focus between cards')).toBeInTheDocument();
    // The keyboard-reschedule bindings are documented (#1742).
    expect(screen.getByText('Reschedule the selected task')).toBeInTheDocument();
    expect(screen.getByText('Nudge by one working day')).toBeInTheDocument();
  });

  it('documents the previously-omitted wired bindings (#2058)', () => {
    render(<KeyboardShortcutsModal onClose={vi.fn()} />);
    // The global `?` hotkey is self-documenting.
    expect(screen.getByText('Show keyboard shortcuts')).toBeInTheDocument();
    // ⌘S save (SettingsShell + TaskDetailDrawer, rules 115/217).
    expect(screen.getByText('Save your changes')).toBeInTheDocument();
    // Continuous zoom / fit (rules 127/129).
    expect(screen.getByText('Zoom in or out')).toBeInTheDocument();
    expect(screen.getByText('Fit the schedule to the project')).toBeInTheDocument();
    // Drag-to-pan (rules 130/131).
    expect(screen.getByText('Hold and drag to pan (or middle-drag)')).toBeInTheDocument();
    // Build-mode sibling reorder (#347) — the schedule reorder binding.
    expect(screen.getByText('Reorder a task among siblings (build mode)')).toBeInTheDocument();
  });

  it('cross-links the per-surface board / build cheatsheets (#2058)', () => {
    render(<KeyboardShortcutsModal onClose={vi.fn()} />);
    expect(
      screen.getByText(/Board and Schedule build mode have more shortcuts/i),
    ).toBeInTheDocument();
  });

  it('renders the OS modifier chip for the command palette shortcut', () => {
    render(<KeyboardShortcutsModal onClose={vi.fn()} />);
    // jsdom is not a Mac → modifierKeyLabel() resolves to "Ctrl".
    expect(screen.getByText('CtrlK')).toBeInTheDocument();
    expect(screen.getByText('CtrlB')).toBeInTheDocument();
    // ⌘S save chip resolves to Ctrl too.
    expect(screen.getByText('CtrlS')).toBeInTheDocument();
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
