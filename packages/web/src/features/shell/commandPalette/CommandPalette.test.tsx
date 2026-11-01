import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';

import { useCommandPaletteStore } from '@/stores/commandPaletteStore';
import { CommandPalette } from './CommandPalette';
import type { CommandItem } from './commandItems';
import { getFocusable } from '@/hooks/useFocusTrap';

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
  {
    id: 'jump:program:apollo',
    label: 'Apollo',
    group: 'jump',
    tag: 'Program',
    pinTarget: { kind: 'program', id: 'apollo', name: 'Apollo', pinned: false },
    run: runApollo,
  },
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
// The no-match fallback (#4504) reads the router + projects list; stub it with a
// mutable list. Query-gating lives in the real hook, so mirror it here.
let mockCrossViews: CommandItem[] = [];
vi.mock('./useCrossProjectViewItems', () => ({
  useCrossProjectViewItems: (_enabled: boolean, query: string) =>
    query.trim() ? mockCrossViews : [],
}));

// Default to an in-context project so the off-project hint stays hidden; the
// off-project test overrides this per-case.
const mockProjectId = vi.fn<() => string | undefined>(() => 'p1');
vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => mockProjectId() }));

// The pin accelerator (#2390) mutates directly from the palette; the spy stands
// in for the shared mutation so no QueryClient is needed here.
const togglePin = vi.fn();
vi.mock('@/hooks/usePins', () => ({
  useTogglePin: () => ({ mutate: togglePin, isPending: false }),
}));

vi.mock('@/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ user: { id: 'u1' } }) }));

// The inline log-time form (#1211) mutates through the shared hook; stub it.
vi.mock('@/hooks/useCreateTimeEntry', () => ({
  useCreateTimeEntry: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false, error: null }),
}));

function open() {
  useCommandPaletteStore.getState().setOpen(true);
}

afterEach(() => {
  useCommandPaletteStore.getState().setOpen(false);
  vi.clearAllMocks();
  // clearAllMocks wipes the implementation too — restore the in-context default.
  mockProjectId.mockReturnValue('p1');
  mockItems = MOCK_ITEMS;
  mockCrossViews = [];
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

  // #3208. The rows above are `tabIndex={-1}` roving members and they trail the
  // dialog, so the broken selector made the LAST row the trap's `last` — a stop
  // the user can never be on, so forward-Tab never wrapped and Tab left the
  // palette entirely. Tabbing BACKWARDS from the real first stop is what catches
  // it: a forward-Tab check reads as passing on the broken build.
  it('keeps Tab inside the dialog with roving option rows present (#3208)', () => {
    open();
    render(<CommandPalette />);
    const dialog = screen.getByRole('dialog', { name: 'Command palette' });

    // The option rows must not be counted as tab stops at all.
    const stops = getFocusable(dialog);
    expect(stops.length).toBeGreaterThan(0);
    expect(stops.some((el) => el.getAttribute('tabindex') === '-1')).toBe(false);
    expect(screen.getAllByRole('option').some((o) => stops.includes(o))).toBe(false);

    const first = stops[0];
    const last = stops[stops.length - 1];

    first.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
    expect(dialog.contains(document.activeElement)).toBe(true);

    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
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

describe('CommandPalette — the pin accelerator (#2390)', () => {
  /**
   * Highlight the pinnable "Apollo" row by filtering down to it — the query
   * resets the selection to index 0, so this does not depend on group order.
   */
  function highlightOnly(query: string) {
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: query } });
    return input;
  }

  it('toggles the highlighted row without closing the palette', () => {
    open();
    render(<CommandPalette />);
    const input = highlightOnly('Apollo');
    expect(screen.getByRole('option', { selected: true })).toHaveTextContent('Apollo');

    fireEvent.keyDown(input, { key: 'p', altKey: true });
    expect(togglePin).toHaveBeenCalledWith({
      kind: 'program',
      id: 'apollo',
      name: 'Apollo',
      next: true,
    });
    // Pinning several projects in one visit is the whole point of a keyboard path.
    expect(useCommandPaletteStore.getState().open).toBe(true);
  });

  it('ignores a bare "p" so the search field can still be typed into', () => {
    open();
    render(<CommandPalette />);
    const input = highlightOnly('Apollo');
    fireEvent.keyDown(input, { key: 'p' });
    expect(togglePin).not.toHaveBeenCalled();
  });

  it('does nothing on a row that names nothing pinnable', () => {
    open();
    render(<CommandPalette />);
    const input = highlightOnly('theme');
    fireEvent.keyDown(input, { key: 'p', altKey: true });
    expect(togglePin).not.toHaveBeenCalled();
  });

  it('advertises the accelerator only while a pinnable row is highlighted', () => {
    open();
    render(<CommandPalette />);
    // The hint is a <kbd> plus a bare text node in one <span>, so assert on the
    // footer's composed text rather than trying to match a split node.
    // A hint for a key that does nothing on this row is worse than no hint.
    highlightOnly('theme');
    expect(screen.getByRole('dialog').textContent).not.toContain('P pin');
    highlightOnly('Apollo');
    expect(screen.getByRole('dialog').textContent).toContain('P pin');
  });
  it('swaps the body for the inline log-time form, and Back restores search focus (#1211)', () => {
    open();
    render(<CommandPalette />);
    act(() => {
      useCommandPaletteStore
        .getState()
        .setLogTimeTarget({ taskId: 't1', taskLabel: 'T-8 · Wire OAuth' });
    });
    expect(screen.getByTestId('cmdk-log-time')).toHaveTextContent('Log time on T-8 · Wire OAuth');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.queryByTestId('cmdk-log-time')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox')).toHaveFocus();
  });

  it('drops the inline form when the palette closes (#1211)', () => {
    open();
    act(() => {
      useCommandPaletteStore.getState().setLogTimeTarget({ taskId: 't1', taskLabel: 'x' });
    });
    act(() => useCommandPaletteStore.getState().setOpen(false));
    expect(useCommandPaletteStore.getState().logTimeTarget).toBeNull();
  });

  it('Escape from the inline log-time form closes the whole palette (#1211)', () => {
    open();
    render(<CommandPalette />);
    act(() => {
      useCommandPaletteStore.getState().setLogTimeTarget({ taskId: 't1', taskLabel: 'x' });
    });
    fireEvent.keyDown(screen.getByLabelText(/minutes/i), { key: 'Escape' });
    expect(useCommandPaletteStore.getState().open).toBe(false);
  });

  it('Tab wraps inside the inline log-time form (#1211)', () => {
    open();
    render(<CommandPalette />);
    act(() => {
      useCommandPaletteStore.getState().setLogTimeTarget({ taskId: 't1', taskLabel: 'x' });
    });
    const minutes = screen.getByLabelText(/minutes/i);
    const log = screen.getByRole('button', { name: /^Log/ });
    expect(minutes).toHaveFocus();
    log.focus();
    fireEvent.keyDown(log, { key: 'Tab' });
    expect(minutes).toHaveFocus();
    fireEvent.keyDown(minutes, { key: 'Tab', shiftKey: true });
    expect(log).toHaveFocus();
  });
});

describe('CommandPalette — ranking and no-match fallback (#4504)', () => {
  it('ranks a project above a task that starts with its name, and Enter opens the project', () => {
    const runProject = vi.fn();
    mockItems = [
      {
        id: 'task:gA',
        label: 'Open task: Platform Core GA',
        group: 'task',
        tag: 'Task',
        run: runOpenTask,
      },
      {
        id: 'jump:project:pc',
        label: 'Platform Core',
        group: 'jump',
        tag: 'Project',
        run: runProject,
      },
    ];
    open();
    render(<CommandPalette />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'Platform Core' } });
    const options = screen.getAllByRole('option');
    expect(options[0]).toHaveAccessibleName(/Platform Core\s*Project/);
    expect(within(screen.getByTestId('cmdk-group-best')).getAllByRole('option')).toHaveLength(1);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(runProject).toHaveBeenCalledTimes(1);
    expect(runOpenTask).not.toHaveBeenCalled();
  });

  it('lists matching views in other projects when nothing matches, navigable like results', () => {
    const runView = vi.fn();
    mockCrossViews = [
      {
        id: 'projectview:pc:sprints',
        label: 'Sprints — Platform Core',
        group: 'projectView',
        tag: 'View',
        run: runView,
      },
    ];
    open();
    render(<CommandPalette />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'Sprints' } });
    expect(screen.getByText(/No matches for “Sprints” here/)).toBeInTheDocument();
    const group = screen.getByRole('group', { name: 'Views in other projects' });
    const opt = within(group).getByRole('option', { name: /Sprints — Platform Core/ });
    expect(input).toHaveAttribute('aria-activedescendant', opt.id);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(runView).toHaveBeenCalledTimes(1);
  });

  it('keeps the plain empty state when no project has the view either', () => {
    open();
    render(<CommandPalette />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'zzzz' } });
    expect(screen.getByText(/No matches for “zzzz”\./)).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Views in other projects' })).toBeNull();
  });
});
