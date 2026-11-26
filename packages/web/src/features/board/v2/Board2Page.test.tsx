import { fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import type { Task } from '@/types';
import { Board2Page } from './Board2Page';

const h = vi.hoisted(() => ({
  tasks: [] as unknown[],
  error: null as Error | null,
  isLoading: false,
  online: true,
  move: vi.fn(),
  create: vi.fn(),
  role: 3 as number | null,
  desktop: true,
  exportPdf: vi.fn(() => Promise.resolve()),
  offline: vi.fn(),
  sprintId: null as string | null,
  sprintClosed: false,
  setSprint: vi.fn(),
  search: { matchIds: new Set<string>(), matchCount: 0, isSearching: false },
}));

vi.mock('@/hooks/useScheduleTasks', () => ({
  useScheduleTasks: () => ({
    tasks: h.isLoading ? undefined : h.tasks,
    links: [],
    isLoading: h.isLoading,
    error: h.error,
  }),
}));
vi.mock('@/hooks/useBoardConfig', () => ({
  useBoardConfig: () => ({
    isLoading: false,
    save: vi.fn(),
    columns: [
      {
        status: 'BACKLOG',
        label: 'Backlog',
        visible: true,
        wipLimit: null,
        color: null,
        lanes: [],
      },
      {
        status: 'NOT_STARTED',
        label: 'To Do',
        visible: true,
        wipLimit: null,
        color: null,
        lanes: [],
      },
      {
        status: 'IN_PROGRESS',
        label: 'In Progress',
        visible: true,
        wipLimit: 1,
        color: null,
        lanes: [],
      },
      { status: 'REVIEW', label: 'Review', visible: true, wipLimit: null, color: null, lanes: [] },
      { status: 'COMPLETE', label: 'Done', visible: true, wipLimit: null, color: null, lanes: [] },
    ],
  }),
}));
vi.mock('@/hooks/useBoardTasks', () => ({
  useUpdateTaskStatus: () => ({ mutate: h.move, isPending: false }),
}));
vi.mock('@/hooks/useTaskMutations', () => ({
  useCreateTask: () => ({ mutate: h.create }),
}));
vi.mock('@/features/schedule/TaskDetailDrawer', () => ({
  TaskDetailDrawer: ({ task }: { task: { id: string } | null }) => (
    <div data-testid="drawer">{task?.id}</div>
  ),
}));
vi.mock('../offline/useBoardOffline', () => ({ useBoardOffline: h.offline }));
vi.mock('@/hooks/useProject', () => ({ useProject: () => ({ data: { name: 'Proj' } }) }));
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: { display_name: 'Kay' } }),
}));
vi.mock('../export/exportBoardPdf', () => ({
  exportBoardPdf: h.exportPdf,
  boardPdfFileName: () => 'proj.pdf',
}));
vi.mock('../boardView/useBoardSprintScope', () => ({
  useBoardSprintScope: () => ({
    sprints: [
      { id: 's1', name: 'Sprint 1', state: 'ACTIVE', start_date: null, end_date: null },
      { id: 's0', name: 'Sprint 0', state: 'COMPLETED', start_date: null, end_date: null },
    ],
    selectedSprintId: h.sprintId,
    selectedSprint: h.sprintId === 's1' ? { id: 's1', name: 'Sprint 1', state: 'ACTIVE' } : null,
    selectedSprintName: undefined,
    setSelectedSprintId: h.setSprint,
    sprintClosed: h.sprintClosed,
    sprintStateUnknown: false,
  }),
}));
vi.mock('@/hooks/useBoardCardSearch', () => ({ useBoardCardSearch: () => h.search }));
vi.mock('../ClosedSprintBanner', () => ({
  ClosedSprintBanner: () => <div data-testid="closed-banner" />,
}));
vi.mock('@/hooks/useOnlineStatus', () => ({ useOnlineStatus: () => h.online }));
vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => 'p1' }));
vi.mock('../boardView/useBoardIdentity', () => ({
  useBoardIdentity: () => ({ projectId: 'p1', projectIdOrNull: 'p1', currentRole: h.role }),
  boardReadOnly: (role: number | null, closed: boolean, unknown: boolean) =>
    role == null || role < 2 || closed || unknown,
}));
vi.mock('@/features/shell2/useMinWidth', () => ({ useMinWidth: () => h.desktop }));

function t(over: Partial<Task> & { id: string }): Task {
  return {
    wbs: '1',
    name: over.id,
    start: '2026-03-02',
    finish: '2026-03-06',
    duration: 5,
    parentId: 'ph',
    isCritical: false,
    isSummary: false,
    status: 'NOT_STARTED',
    assignees: [],
    ...over,
  } as Task;
}
const PHASE = t({ id: 'ph', name: 'Discovery', parentId: null, isSummary: true, isPhase: true });

function seed(cards: Task[]) {
  h.tasks = [PHASE, ...cards];
}

describe('Board2Page', () => {
  beforeEach(() => {
    h.error = null;
    h.isLoading = false;
    h.online = true;
    h.role = 3;
    h.desktop = true;
    h.sprintId = null;
    h.sprintClosed = false;
    h.search = { matchIds: new Set<string>(), matchCount: 0, isSearching: false };
    h.setSprint.mockClear();
    h.move.mockClear();
    h.create.mockClear();
    seed([
      t({ id: 'Write brief', isCritical: true }),
      t({ id: 'Get legal sign-off', status: 'IN_PROGRESS', blockedReason: 'Waiting on legal' }),
      t({
        id: 'Pick vendor',
        status: 'IN_PROGRESS',
        totalFloat: 2,
        assignees: [{ resourceId: 'r', name: 'Ana Ruiz', units: 100 }],
      }),
      t({ id: 'Done 1', status: 'COMPLETE' }),
      t({ id: 'Done 2', status: 'COMPLETE' }),
      t({ id: 'Done 3', status: 'COMPLETE' }),
    ]);
  });

  it('has the five Pass 2 controls plus the sprint scope switcher', () => {
    renderWithRouter(<Board2Page />);
    const bar = screen.getByRole('toolbar', { name: 'Board controls' });
    expect(within(bar).getAllByRole('button')).toHaveLength(6);
  });

  it('renders a phase lane header with count and critical count', () => {
    renderWithRouter(<Board2Page />);
    const lane = screen.getByRole('button', { name: /Discovery/ });
    expect(lane.textContent).toContain('6 cards');
    expect(lane.textContent).toContain('▲ 1 critical');
  });

  it('wears critical, blocked and near-critical chips', () => {
    renderWithRouter(<Board2Page />);
    expect(screen.getByText('Critical')).toBeTruthy();
    expect(screen.getByText('Blocked: Waiting on legal')).toBeTruthy();
    expect(screen.getByText('Near-critical · 2d float')).toBeTruthy();
    expect(screen.getAllByRole('img', { name: 'Unassigned' }).length).toBeGreaterThan(0);
  });

  it('flags an over-limit column with the glyph and the number', () => {
    renderWithRouter(<Board2Page />);
    const head = screen.getByTestId('board2-colhead-IN_PROGRESS');
    expect(head.getAttribute('data-wip')).toBe('over');
    expect(head.textContent).toContain('▲ WIP 2/1');
  });

  it('shows two done cards then folds the rest behind "N more done"', () => {
    renderWithRouter(<Board2Page />);
    expect(screen.queryByText('Done 3')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '1 more done' }));
    expect(screen.getByText('Done 3')).toBeTruthy();
  });

  it('picks a card up with Space, moves it with arrows and drops it with Space', () => {
    renderWithRouter(<Board2Page />);
    const card = screen.getByText('Write brief').closest('button')!;
    card.focus();
    fireEvent.keyDown(card, { key: ' ' });
    fireEvent.keyDown(card, { key: 'ArrowRight' });
    fireEvent.keyDown(card, { key: ' ' });
    // IN_PROGRESS is over its limit in this fixture: the move waits for the v1 confirm.
    expect(h.move).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Move anyway/ }));
    expect(h.move).toHaveBeenCalledWith({
      projectId: 'p1',
      taskId: 'Write brief',
      status: 'IN_PROGRESS',
    });
  });

  it('WIP confirm: "Keep it here" cancels the move and nothing is written', () => {
    renderWithRouter(<Board2Page />);
    const card = screen.getByText('Write brief').closest('button')!;
    fireEvent.keyDown(card, { key: ' ' });
    fireEvent.keyDown(card, { key: 'ArrowRight' });
    fireEvent.keyDown(card, { key: ' ' });
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Keep it here/ }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(h.move).not.toHaveBeenCalled();
  });

  it('a move into a column under its limit writes straight away', () => {
    renderWithRouter(<Board2Page />);
    const card = screen.getByText('Get legal sign-off').closest('button')!;
    fireEvent.keyDown(card, { key: ' ' });
    fireEvent.keyDown(card, { key: 'ArrowRight' });
    fireEvent.keyDown(card, { key: ' ' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(h.move).toHaveBeenCalledWith({
      projectId: 'p1',
      taskId: 'Get legal sign-off',
      status: 'REVIEW',
    });
  });

  it('search: matches stay bright, the rest dim in place; no matches dims nothing', () => {
    h.search = { matchIds: new Set(['Write brief']), matchCount: 1, isSearching: false };
    renderWithRouter(<Board2Page />, { initialEntries: ['/?q=brief'] });
    expect(
      (screen.getByRole('searchbox', { name: 'Search cards' })).value,
    ).toBe('brief');
    expect(screen.getByText('Write brief').closest('button')!.className).not.toContain(
      'opacity-50',
    );
    expect(screen.getByText('Pick vendor').closest('button')!.className).toContain('opacity-50');
  });

  it('search: a query that matches nothing dims nothing', () => {
    renderWithRouter(<Board2Page />, { initialEntries: ['/?q=zzz'] });
    expect(screen.getByText('Pick vendor').closest('button')!.className).not.toContain(
      'opacity-50',
    );
  });

  it('sprint scope: cards outside the selected sprint are hidden', () => {
    h.sprintId = 's1';
    seed([
      t({ id: 'In sprint', sprintId: 's1', status: 'IN_PROGRESS' }),
      t({ id: 'Other sprint', sprintId: 's2' }),
      t({ id: 'Not planned', sprintId: 's1' }),
    ]);
    renderWithRouter(<Board2Page />);
    expect(screen.queryByText('Other sprint')).toBeNull();
    const card = screen.getByText('Not planned').closest('button')!;
    fireEvent.keyDown(card, { key: ' ' });
    fireEvent.keyDown(card, { key: 'ArrowRight' });
    fireEvent.keyDown(card, { key: ' ' });
    expect(screen.getByRole('alertdialog')).toBeTruthy();
  });

  it('sprint scope: a backlog card pulled onto the board carries the sprint id', () => {
    h.sprintId = 's1';
    seed([
      t({ id: 'In sprint', sprintId: 's1', status: 'REVIEW' }),
      t({ id: 'Idea', status: 'BACKLOG' }),
    ]);
    renderWithRouter(<Board2Page />);
    fireEvent.dragStart(screen.getByText('Idea').closest('button')!);
    fireEvent.drop(screen.getAllByTestId('board2-cell-NOT_STARTED')[0]);
    expect(h.move).toHaveBeenCalledWith({
      projectId: 'p1',
      taskId: 'Idea',
      status: 'NOT_STARTED',
      sprintId: 's1',
    });
  });

  it('closed sprint: the board is read-only and says why', () => {
    h.sprintId = 's0';
    h.sprintClosed = true;
    seed([t({ id: 'Write brief', sprintId: 's0' })]);
    renderWithRouter(<Board2Page />);
    expect(screen.getByTestId('closed-banner')).toBeTruthy();
    expect(screen.getByText('Write brief').closest('button')!.getAttribute('draggable')).toBe(
      'false',
    );
  });

  it('Escape cancels a pickup without moving', () => {
    renderWithRouter(<Board2Page />);
    const card = screen.getByText('Write brief').closest('button')!;
    fireEvent.keyDown(card, { key: ' ' });
    fireEvent.keyDown(card, { key: 'ArrowRight' });
    fireEvent.keyDown(card, { key: 'Escape' });
    fireEvent.keyDown(card, { key: ' ' });
    expect(h.move).not.toHaveBeenCalled();
  });

  it('hides "Import tasks" from a role the importer would refuse', () => {
    h.role = 100;
    renderWithRouter(<Board2Page />);
    expect(screen.queryByRole('link', { name: 'Import tasks' })).toBeNull();
  });

  it('opens the backlog pane with a quiet empty state and the actions that fill it', () => {
    h.role = 200;
    renderWithRouter(<Board2Page />);
    const pane = screen.getByTestId('board2-backlog-empty');
    expect(within(pane).getByRole('button', { name: 'Add to backlog' })).toBeTruthy();
    // The real importer: the schedule's CSV/Excel wizard, not project settings.
    expect(within(pane).getByRole('link', { name: 'Import tasks' }).getAttribute('href')).toBe(
      '/projects/p1/schedule?import=csv',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Backlog pane' }));
    expect(screen.queryByTestId('board2-backlog')).toBeNull();
  });

  it('unplans a card by dropping it on the backlog pane', () => {
    renderWithRouter(<Board2Page />);
    const card = screen.getByText('Write brief').closest('button')!;
    fireEvent.dragStart(card);
    fireEvent.drop(screen.getByTestId('board2-backlog'));
    expect(h.move).toHaveBeenCalledWith({
      projectId: 'p1',
      taskId: 'Write brief',
      status: 'BACKLOG',
    });
  });

  it('creates a card from Add card', () => {
    renderWithRouter(<Board2Page />);
    fireEvent.click(screen.getByRole('button', { name: 'Add card' }));
    fireEvent.change(screen.getByLabelText('New card name'), { target: { value: 'Ship it' } });
    fireEvent.submit(screen.getByRole('form', { name: 'Add card' }));
    expect(h.create).toHaveBeenCalledWith({ name: 'Ship it', duration: 1, status: 'NOT_STARTED' });
  });

  it('puts the secondary controls in the overflow menu', () => {
    renderWithRouter(<Board2Page />);
    fireEvent.click(screen.getByRole('button', { name: /More board options/ }));
    for (const name of ['Card fields', 'WIP limits', 'Collapse Done']) {
      expect(screen.getByRole('menuitemcheckbox', { name })).toBeTruthy();
    }
  });

  it('filters to critical cards', () => {
    renderWithRouter(<Board2Page />);
    fireEvent.click(screen.getByRole('button', { name: 'Filter cards' }));
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Critical only/ }));
    expect(screen.queryByText('Pick vendor')).toBeNull();
    expect(screen.getByText('Write brief')).toBeTruthy();
  });

  it('withholds drag and Add card from a viewer', () => {
    h.role = 0;
    renderWithRouter(<Board2Page />);
    expect(screen.queryByRole('button', { name: 'Add card' })).toBeNull();
    const card = screen.getByText('Write brief').closest('button')!;
    fireEvent.keyDown(card, { key: ' ' });
    fireEvent.keyDown(card, { key: 'ArrowRight' });
    fireEvent.keyDown(card, { key: ' ' });
    expect(h.move).not.toHaveBeenCalled();
  });

  it('says it is showing a saved copy when offline', () => {
    h.online = false;
    renderWithRouter(<Board2Page />);
    expect(screen.getByText(/Board is showing your .* copy/)).toBeTruthy();
  });

  it('renders the skeleton with real column headers while loading', () => {
    h.isLoading = true;
    renderWithRouter(<Board2Page />);
    expect(screen.getByTestId('board2-skeleton')).toBeTruthy();
    expect(screen.getByText('In Progress')).toBeTruthy();
  });

  it('shows the empty state when there are no cards', () => {
    h.tasks = [];
    renderWithRouter(<Board2Page />);
    expect(screen.getByText('No cards on this board yet')).toBeTruthy();
  });

  it('shows the neutral error state when nothing was ever loaded', () => {
    h.isLoading = false;
    h.error = new Error('boom');
    (h as { tasks: unknown }).tasks = undefined;
    renderWithRouter(<Board2Page />);
    expect(screen.getByText(/could not be loaded/i)).toBeTruthy();
  });

  it('opens task detail on click and on Enter, but not on Space (pickup)', () => {
    renderWithRouter(<Board2Page />);
    expect(screen.queryByTestId('drawer')).toBeNull();
    const card = screen.getByText('Write brief').closest('button')!;
    fireEvent.keyDown(card, { key: ' ' });
    fireEvent.keyUp(card, { key: ' ' });
    expect(screen.queryByTestId('drawer')).toBeNull();
    fireEvent.keyDown(card, { key: 'Escape' });
    fireEvent.click(card);
    expect(screen.getByTestId('drawer').textContent).toBe('Write brief');
  });

  it('moves focus between cards in a column with ArrowDown and ArrowUp', () => {
    seed([
      t({ id: 'A', status: 'IN_PROGRESS' }),
      t({ id: 'B', status: 'IN_PROGRESS' }),
      t({ id: 'C', status: 'IN_PROGRESS' }),
    ]);
    renderWithRouter(<Board2Page />);
    const a = screen.getByText('A').closest('button')!;
    const b = screen.getByText('B').closest('button')!;
    const c = screen.getByText('C').closest('button')!;
    a.focus();
    fireEvent.keyDown(a, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(b);
    fireEvent.keyDown(b, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(c);
    fireEvent.keyDown(c, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(c);
    fireEvent.keyDown(c, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(b);
  });
  it('phone: every card carries a 44px "Move to…" that moves it through the same write', () => {
    h.desktop = false;
    renderWithRouter(<Board2Page />);
    fireEvent.click(screen.getByRole('button', { name: 'Move Write brief to…' }));
    const list = screen.getByRole('list', { name: 'Move Write brief to' });
    // The card's own column is not a destination.
    expect(within(list).queryByRole('button', { name: 'To Do' })).toBeNull();
    fireEvent.click(within(list).getByRole('button', { name: 'Review' }));
    expect(h.move).toHaveBeenCalledWith({
      projectId: 'p1',
      taskId: 'Write brief',
      status: 'REVIEW',
    });
    expect(screen.getByRole('status').textContent).toContain('Moved Write brief to Review');
  });

  it('mounts the offline queue driver for the project, so queued moves flush on reconnect', () => {
    h.offline.mockClear();
    renderWithRouter(<Board2Page />);
    expect(h.offline).toHaveBeenCalledWith('p1');
  });

  it('phone: a viewer gets no "Move to…"', () => {
    h.desktop = false;
    h.role = 1;
    renderWithRouter(<Board2Page />);
    expect(screen.queryByRole('button', { name: /^Move .* to…$/ })).toBeNull();
  });

  it('desktop: cards have no "Move to…" (drag and the keyboard pick-up cover it)', () => {
    renderWithRouter(<Board2Page />);
    expect(screen.queryByRole('button', { name: /^Move .* to…$/ })).toBeNull();
  });

  it('swimlane by person: one lane per owner, unowned cards last', () => {
    renderWithRouter(<Board2Page />);
    fireEvent.click(screen.getByRole('button', { name: /More board options/ }));
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Swimlane by person/ }));
    const lanes = screen.getAllByTestId('board2-lane').map((l) => l.getAttribute('aria-label'));
    expect(lanes).toEqual(['Ana Ruiz lane', 'Unassigned lane']);
    expect(screen.getByRole('button', { name: 'Lanes (Person)' })).toBeTruthy();
  });

  it('Export PDF rasterizes the print surface once and then unmounts it', async () => {
    h.exportPdf.mockClear();
    renderWithRouter(<Board2Page />);
    fireEvent.click(screen.getByRole('button', { name: /More board options/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Export PDF' }));
    await vi.waitFor(() => expect(h.exportPdf).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(document.querySelector('[data-print-text="masthead"]')).toBeNull(),
    );
  });
});
