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
vi.mock('@/hooks/useOnlineStatus', () => ({ useOnlineStatus: () => h.online }));
vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => 'p1' }));
vi.mock('../boardView/useBoardIdentity', () => ({
  useBoardIdentity: () => ({ projectId: 'p1', projectIdOrNull: 'p1', currentRole: h.role }),
  boardReadOnly: (role: number | null) => role == null || role < 2,
}));
vi.mock('@/features/shell2/useMinWidth', () => ({ useMinWidth: () => true }));

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

  it('has at most five toolbar controls', () => {
    renderWithRouter(<Board2Page />);
    const bar = screen.getByRole('toolbar', { name: 'Board controls' });
    expect(within(bar).getAllByRole('button')).toHaveLength(5);
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
    expect(h.move).toHaveBeenCalledWith({
      projectId: 'p1',
      taskId: 'Write brief',
      status: 'IN_PROGRESS',
    });
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

  it('opens the backlog pane with a quiet empty state and the actions that fill it', () => {
    renderWithRouter(<Board2Page />);
    const pane = screen.getByTestId('board2-backlog-empty');
    expect(within(pane).getByRole('button', { name: 'Add to backlog' })).toBeTruthy();
    expect(within(pane).getByRole('link', { name: 'Import tasks' })).toBeTruthy();
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
});
