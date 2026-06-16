import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

import { useCommandPaletteStore } from '@/stores/commandPaletteStore';
import { CommandPalette } from './CommandPalette';
import type { CommandItem } from './commandItems';

// Stub the live item builder (router + data hooks) with deterministic items.
const runMyWork = vi.fn();
const runApollo = vi.fn();
const runTheme = vi.fn();
const runOpenTask = vi.fn();
const MOCK_ITEMS: CommandItem[] = [
  {
    id: 'task:t1',
    label: 'Open task: Wire OAuth callback',
    group: 'task',
    tag: 'Task',
    detail: '1.4.2 · In progress',
    keywords: 'oauth',
    run: runOpenTask,
  },
  {
    id: 'current:active-sprint:p1',
    label: 'Active Sprint — Sprint 14',
    group: 'current',
    tag: 'Sprint',
    run: vi.fn(),
  },
  { id: 'jump:my-work', label: 'My Work', group: 'jump', tag: 'View', run: runMyWork },
  { id: 'jump:program:apollo', label: 'Apollo', group: 'jump', tag: 'Program', run: runApollo },
  { id: 'action:theme', label: 'Switch theme', group: 'action', tag: 'Action', keywords: 'dark', run: runTheme },
];
vi.mock('./useCommandItems', () => ({ useCommandItems: () => MOCK_ITEMS }));

// Default to an in-context project so the off-project hint stays hidden; the
// off-project test overrides this per-case.
const mockProjectId = vi.fn<() => string | undefined>(() => 'p1');
vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => mockProjectId() }));

function open() {
  useCommandPaletteStore.getState().setOpen(true);
}

afterEach(() => {
  useCommandPaletteStore.getState().setOpen(false);
  vi.clearAllMocks();
  // clearAllMocks wipes the implementation too — restore the in-context default.
  mockProjectId.mockReturnValue('p1');
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
    // Cold (empty query) the Tasks group is gated out, so the first visible item
    // is the current-project Active Sprint; ArrowDown lands on My Work.
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(runMyWork).toHaveBeenCalledTimes(1);
    // From My Work (index 1), one more ArrowDown → Apollo (index 2).
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
    // Cold, the Tasks group is gated out, so the first option is Active Sprint.
    expect(input).toHaveAttribute('aria-activedescendant', 'cmdk-opt-current:active-sprint:p1');
    const dialog = screen.getByRole('dialog');
    const selected = within(dialog).getByRole('option', { selected: true });
    expect(selected).toHaveTextContent('Active Sprint');
  });

  it('gates the Tasks group behind a query, then reveals matches', () => {
    open();
    render(<CommandPalette />);
    // Cold: no task rows, no "Tasks" header.
    expect(screen.queryByRole('option', { name: /Open task/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Tasks')).not.toBeInTheDocument();
    // Typing a task match reveals the Tasks group.
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'oauth' } });
    expect(screen.getByText('Tasks')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Open task: Wire OAuth callback/ })).toBeInTheDocument();
  });

  it('opens the task drawer (runs the task item) on Enter', () => {
    open();
    render(<CommandPalette />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'oauth' } });
    // The task is the first (and only) match → Enter runs its action.
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(runOpenTask).toHaveBeenCalledTimes(1);
  });

  it('shows a drawer-specific footer hint when a task row is active', () => {
    open();
    render(<CommandPalette />);
    const input = screen.getByRole('combobox');
    expect(screen.getByText('open')).toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'oauth' } });
    expect(screen.getByText('open in drawer')).toBeInTheDocument();
  });

  it('renders the task detail line (short id · status)', () => {
    open();
    render(<CommandPalette />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'oauth' } });
    expect(screen.getByText('1.4.2 · In progress')).toBeInTheDocument();
  });

  it('shows the off-project hint only when there is no current project (cold)', () => {
    mockProjectId.mockReturnValue(undefined);
    open();
    render(<CommandPalette />);
    expect(screen.getByText('Open a project to search its tasks and sprint.')).toBeInTheDocument();
  });

  it('hides the off-project hint when a project is in context', () => {
    open();
    render(<CommandPalette />);
    expect(
      screen.queryByText('Open a project to search its tasks and sprint.'),
    ).not.toBeInTheDocument();
  });
});
