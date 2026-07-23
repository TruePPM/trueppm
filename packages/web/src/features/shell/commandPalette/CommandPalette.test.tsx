import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';

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
    id: 'sprint:s1',
    label: 'Current sprint — Sprint 14',
    group: 'sprint',
    tag: 'Sprint',
    detail: 'Atlas',
    run: vi.fn(),
  },
  { id: 'jump:my-work', label: 'My Work', group: 'jump', tag: 'View', run: runMyWork },
  { id: 'jump:program:apollo', label: 'Apollo', group: 'jump', tag: 'Program', run: runApollo },
  {
    id: 'action:theme',
    label: 'Switch theme',
    group: 'action',
    tag: 'Action',
    keywords: 'dark',
    run: runTheme,
  },
];
// Mutable so a test can swap in a large task/person set to exercise the caps.
let mockItems: CommandItem[] = MOCK_ITEMS;
vi.mock('./useCommandItems', () => ({ useCommandItems: () => mockItems }));

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
  mockItems = MOCK_ITEMS;
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

  it('keeps options out of the tab order so Tab/Escape stay on the combobox (#2203)', () => {
    open();
    render(<CommandPalette />);
    for (const opt of screen.getAllByRole('option')) {
      expect(opt).toHaveAttribute('tabindex', '-1');
    }
  });

  it('announces the settled result count to screen readers after a debounce (#2203)', () => {
    vi.useFakeTimers();
    try {
      open();
      render(<CommandPalette />);
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'apollo' } });
      // Not announced mid-keystroke…
      expect(screen.queryByText(/result/i)).not.toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(300);
      });
      // …the sr-only status region reports the settled count.
      expect(screen.getByText(/1 result/i)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs the active item on Enter, and moves the selection with ArrowDown', () => {
    open();
    render(<CommandPalette />);
    const input = screen.getByRole('combobox');
    // Cold (empty query) the Tasks group is gated out, so the first visible item
    // is the top-ranked Current sprint jump; ArrowDown lands on My Work.
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
    // Cold, the Tasks group is gated out, so the first option is the Current sprint jump.
    expect(input).toHaveAttribute('aria-activedescendant', 'cmdk-opt-sprint:s1');
    const dialog = screen.getByRole('dialog');
    const selected = within(dialog).getByRole('option', { selected: true });
    expect(selected).toHaveTextContent('Current sprint');
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
    expect(
      screen.getByRole('option', { name: /Open task: Wire OAuth callback/ }),
    ).toBeInTheDocument();
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

  it('caps task results at 8 and surfaces an explicit overflow hint (#1940)', () => {
    mockItems = Array.from({ length: 10 }, (_, i) => ({
      id: `task:t${i}`,
      label: `Open task: Widget ${i}`,
      group: 'task' as const,
      tag: 'Task',
      keywords: 'widget',
      run: vi.fn(),
    }));
    open();
    render(<CommandPalette />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'widget' } });
    // Only 8 of the 10 task options render...
    expect(screen.getAllByRole('option', { name: /Open task: Widget/ })).toHaveLength(8);
    // ...and the truncation is called out, never silent.
    expect(screen.getByText(/Showing first 8 — refine your search/)).toBeInTheDocument();
  });

  it('renders a People group and caps it at 6 with an overflow hint (#1940)', () => {
    mockItems = Array.from({ length: 8 }, (_, i) => ({
      id: `person:r${i}`,
      label: `Ann ${i}`,
      group: 'person' as const,
      tag: 'Person',
      keywords: 'person',
      run: vi.fn(),
    }));
    open();
    render(<CommandPalette />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'ann' } });
    expect(screen.getByText('People')).toBeInTheDocument();
    expect(screen.getAllByRole('option', { name: /Ann/ })).toHaveLength(6);
    expect(screen.getByText(/Showing first 6 — refine your search/)).toBeInTheDocument();
  });

  it('caps active-sprint tasks at 25 and names the total in the overflow hint (ADR-0508)', () => {
    mockItems = Array.from({ length: 30 }, (_, i) => ({
      id: `task:s${i}`,
      label: `Open task: Widget ${i}`,
      group: 'sprintTask' as const,
      tag: 'Task',
      keywords: 'widget',
      run: vi.fn(),
    }));
    open();
    render(<CommandPalette />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'widget' } });
    expect(screen.getByText('Current sprint tasks')).toBeInTheDocument();
    // 25 of the 30 render, and the cue names the total (bounded, countable set).
    expect(screen.getAllByRole('option', { name: /Open task: Widget/ })).toHaveLength(25);
    expect(
      screen.getByText(/Showing 25 of 30 — refine your search to narrow it down\./),
    ).toBeInTheDocument();
  });

  it('renders the Recent group cold and drops it once a query is typed (ADR-0508)', () => {
    mockItems = [
      {
        id: 'recent:p1',
        label: 'Atlas',
        group: 'recent' as const,
        tag: 'Project',
        detail: 'Platform · 2h ago',
        keywords: 'recent',
        run: vi.fn(),
      },
      ...MOCK_ITEMS,
    ];
    open();
    render(<CommandPalette />);
    // Cold: the Recent group + its row (uniquely identified by the recency detail).
    expect(screen.getByText('Recent')).toBeInTheDocument();
    expect(screen.getByText('Platform · 2h ago')).toBeInTheDocument();
    // Typing drops recent (search is owned by `jump`), even for a matching query.
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'atlas' } });
    expect(screen.queryByText('Recent')).not.toBeInTheDocument();
    expect(screen.queryByText('Platform · 2h ago')).not.toBeInTheDocument();
  });

  it('holds the settings-section group until a query is typed (query-only, #2319)', () => {
    mockItems = [
      {
        id: 'settings:ws:sso',
        label: 'Single sign-on',
        group: 'settings' as const,
        tag: 'Settings',
        detail: 'Workspace',
        keywords: 'oidc saml',
        run: vi.fn(),
      },
      ...MOCK_ITEMS,
    ];
    open();
    render(<CommandPalette />);
    // Cold: the Settings section group and its row are absent (unlike the 3 cold
    // top-level jumps), so an empty palette isn't flooded with ~20 sections.
    expect(screen.queryByText('Single sign-on')).not.toBeInTheDocument();
    // Typing a synonym surfaces the section row (its presence proves the group
    // rendered; the "Settings" label collides with the tag chip so isn't asserted).
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'oidc' } });
    expect(screen.getByRole('option', { name: /Single sign-on/ })).toBeInTheDocument();
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
