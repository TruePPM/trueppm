import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

import { useCommandPaletteStore } from '@/stores/commandPaletteStore';
import { CommandPalette } from './CommandPalette';
import type { CommandItem } from './commandItems';

// Stub the live item builder (router + data hooks) with deterministic items.
const runMyWork = vi.fn();
const runApollo = vi.fn();
const runTheme = vi.fn();
const MOCK_ITEMS: CommandItem[] = [
  { id: 'jump:my-work', label: 'My Work', group: 'jump', tag: 'View', run: runMyWork },
  { id: 'jump:program:apollo', label: 'Apollo', group: 'jump', tag: 'Program', run: runApollo },
  { id: 'action:theme', label: 'Switch theme', group: 'action', tag: 'Action', keywords: 'dark', run: runTheme },
];
vi.mock('./useCommandItems', () => ({ useCommandItems: () => MOCK_ITEMS }));

function open() {
  useCommandPaletteStore.getState().setOpen(true);
}

afterEach(() => {
  useCommandPaletteStore.getState().setOpen(false);
  vi.clearAllMocks();
});

describe('CommandPalette', () => {
  it('renders nothing when closed', () => {
    render(<CommandPalette />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders grouped items when open', () => {
    open();
    render(<CommandPalette />);
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
    expect(screen.getByText('Jump to')).toBeInTheDocument();
    expect(screen.getByText('Actions')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /My Work/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Switch theme/ })).toBeInTheDocument();
  });

  it('filters as the user types', () => {
    open();
    render(<CommandPalette />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'apollo' } });
    expect(screen.getByRole('option', { name: /Apollo/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /My Work/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Switch theme/ })).not.toBeInTheDocument();
  });

  it('shows an empty state when nothing matches', () => {
    open();
    render(<CommandPalette />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'zzzz' } });
    expect(screen.getByText(/No matches/)).toBeInTheDocument();
  });

  it('runs the active item on Enter, and moves the selection with ArrowDown', () => {
    open();
    render(<CommandPalette />);
    const input = screen.getByRole('combobox');
    // First item active by default → Enter runs My Work.
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(runMyWork).toHaveBeenCalledTimes(1);
    // ArrowDown to the 2nd item → Enter runs Apollo.
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(runApollo).toHaveBeenCalledTimes(1);
  });

  it('runs an item on click', () => {
    open();
    render(<CommandPalette />);
    fireEvent.click(screen.getByRole('option', { name: /Switch theme/ }));
    expect(runTheme).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape', () => {
    open();
    render(<CommandPalette />);
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    expect(useCommandPaletteStore.getState().open).toBe(false);
  });

  it('marks the active option with aria-selected and wires aria-activedescendant', () => {
    open();
    render(<CommandPalette />);
    const input = screen.getByRole('combobox');
    expect(input).toHaveAttribute('aria-activedescendant', 'cmdk-opt-jump:my-work');
    const dialog = screen.getByRole('dialog');
    const selected = within(dialog).getByRole('option', { selected: true });
    expect(selected).toHaveTextContent('My Work');
  });
});
