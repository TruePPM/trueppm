/**
 * ProjectWorkflowPage — drag-to-reorder behavior for phases and statuses (#2459).
 *
 * dnd-kit's pointer/keyboard sensors need real layout rects, which jsdom does not
 * provide, so this companion suite replaces the dnd-kit modules with thin stubs
 * that (a) hand us the `onDragEnd` callback each DndContext registers and (b) let
 * a test declare which row is mid-drag. Everything asserted below is the page's
 * own behavior: the optimistic reordering of the visible list, what gets
 * persisted, and the guards that make a stray drop a no-op.
 *
 * It lives beside ProjectWorkflowPage.test.tsx rather than inside it because
 * `vi.mock` is file-scoped — stubbing dnd-kit there would strip the real sortable
 * wiring from every other test in that suite.
 */
import { act, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { ProjectWorkflowPage } from './ProjectWorkflowPage';
import { ROLE_ADMIN } from '@/lib/roles';
import type { ProjectPhase } from '@/hooks/useProjectPhases';
import type { BoardColumnDef } from '@/hooks/useBoardConfig';

/** Minimal shape of the drag-end event the page actually reads. */
interface StubDragEndEvent {
  active: { id: string };
  over: { id: string } | null;
}
type DragEndHandler = (event: StubDragEndEvent) => void;

const dnd = vi.hoisted(() => ({
  /** Every `onDragEnd` registered during the latest render pass, in tree order:
   *  phases first, then statuses. */
  handlers: [] as unknown[],
  /** Ids the sortable stub should report as currently being dragged. */
  dragging: new Set<string>(),
}));

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children, onDragEnd }: { children: ReactNode; onDragEnd: DragEndHandler }) => {
    dnd.handlers.push(onDragEnd);
    return <>{children}</>;
  },
  closestCenter: () => [],
  useSensor: () => ({}),
  useSensors: (...sensors: unknown[]) => sensors,
  KeyboardSensor: {},
  PointerSensor: {},
}));

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: ReactNode }) => <>{children}</>,
  sortableKeyboardCoordinates: () => undefined,
  verticalListSortingStrategy: 'vertical',
  useSortable: ({ id }: { id: string }) => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => undefined,
    transform: null,
    transition: undefined,
    isDragging: dnd.dragging.has(id),
  }),
}));

vi.mock('@dnd-kit/utilities', () => ({
  CSS: { Transform: { toString: () => undefined } },
}));

// --- Data hooks ------------------------------------------------------------

const useCurrentUserRole = vi.fn();
const useProjectPhases = vi.fn();
const useBoardConfig = vi.fn();
const useProjectCustomFields = vi.fn();
const useProject = vi.fn();
const useUpdateProject = vi.fn();
const useActiveSprint = vi.fn();

const phaseReorder = vi.fn<(ids: string[], opts: { onSettled: () => void }) => void>();
const boardSave = vi.fn<(columns: BoardColumnDef[]) => Promise<void>>();

vi.mock('@/hooks/useCurrentUserRole', () => ({
  useCurrentUserRole: () => useCurrentUserRole() as { role: number | null; isLoading: boolean },
}));
vi.mock('@/hooks/useProjectPhases', () => ({
  useProjectPhases: () => useProjectPhases() as unknown,
}));
vi.mock('@/hooks/useBoardConfig', () => ({
  useBoardConfig: () => useBoardConfig() as unknown,
  COLUMN_SLA_DEFAULTS: { BACKLOG: 14, NOT_STARTED: 7, IN_PROGRESS: 10, REVIEW: 4 },
}));
vi.mock('@/hooks/useProject', () => ({
  useProject: () => useProject() as { data: unknown; isLoading: boolean },
}));
vi.mock('@/hooks/useProjectMutations', () => ({
  useUpdateProject: () => useUpdateProject() as unknown,
}));
vi.mock('@/hooks/useSprints', () => ({
  useActiveSprint: () => useActiveSprint() as { sprint: unknown; isLoading: boolean },
}));
vi.mock('@/hooks/useProjectCustomFields', () => ({
  useProjectCustomFields: () => useProjectCustomFields() as unknown,
}));

function makePhase(o: Partial<ProjectPhase> = {}): ProjectPhase {
  return {
    id: 'p1',
    name: 'Engineering',
    color: '#3E8C6D',
    priorityRank: 10,
    wbsPath: '1',
    taskCount: 3,
    serverVersion: 1,
    ...o,
  };
}

function makeColumn(o: Partial<BoardColumnDef> = {}): BoardColumnDef {
  return {
    status: 'BACKLOG',
    label: 'Backlog',
    visible: true,
    wipLimit: null,
    color: '#94A3B8',
    ageThresholdDays: null,
    ...o,
  };
}

function setPhases(phases: ProjectPhase[]) {
  useProjectPhases.mockReturnValue({
    phases,
    isLoading: false,
    error: null,
    create: { mutate: vi.fn(), isPending: false, error: null },
    update: { mutate: vi.fn(), isPending: false },
    remove: { mutate: vi.fn(), isPending: false, error: null, variables: undefined },
    reorder: { mutate: phaseReorder },
  });
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // A fresh element each call: re-rendering the identical element object makes
  // React bail out, which would hide a changed hook return.
  const tree = () => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/projects/p1/settings/workflow']}>
        <Routes>
          <Route path="/projects/:projectId/settings/workflow" element={<ProjectWorkflowPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const result = render(tree());
  return { ...result, replay: () => result.rerender(tree()) };
}

/** The two `onDragEnd` callbacks registered by the newest render pass. */
function latestHandlers(): { phases: DragEndHandler; statuses: DragEndHandler } {
  expect(dnd.handlers.length).toBeGreaterThanOrEqual(2);
  const [phases, statuses] = dnd.handlers.slice(-2) as DragEndHandler[];
  return { phases, statuses };
}

function drop(handler: DragEndHandler, activeId: string, overId: string | null) {
  act(() => {
    handler({ active: { id: activeId }, over: overId === null ? null : { id: overId } });
  });
}

function phaseNamesInOrder(): string[] {
  const region = screen.getByRole('region', { name: /Phases/i });
  return within(region)
    .getAllByRole('button', { name: /^Reorder phase / })
    .map((handle) => handle.getAttribute('aria-label')?.replace('Reorder phase ', '') ?? '');
}

function statusLabelsInOrder(): string[] {
  const region = screen.getByRole('region', { name: /Statuses/i });
  return within(region)
    .getAllByRole('button', { name: /^Reorder status / })
    .map((handle) => handle.getAttribute('aria-label')?.replace('Reorder status ', '') ?? '');
}

beforeEach(() => {
  vi.clearAllMocks();
  dnd.handlers.length = 0;
  dnd.dragging.clear();
  boardSave.mockResolvedValue(undefined);
  useCurrentUserRole.mockReturnValue({ role: ROLE_ADMIN, isLoading: false });
  setPhases([
    makePhase({ id: 'p1', name: 'Discovery' }),
    makePhase({ id: 'p2', name: 'Build' }),
    makePhase({ id: 'p3', name: 'Launch' }),
  ]);
  useBoardConfig.mockReturnValue({
    columns: [
      makeColumn({ status: 'BACKLOG', label: 'Backlog' }),
      makeColumn({ status: 'IN_PROGRESS', label: 'Doing' }),
      makeColumn({ status: 'COMPLETE', label: 'Done' }),
    ],
    isLoading: false,
    save: boardSave,
  });
  useProject.mockReturnValue({
    data: { board_cadence: 'sprint', methodology: 'AGILE' },
    isLoading: false,
  });
  useUpdateProject.mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
  });
  useActiveSprint.mockReturnValue({ sprint: null, isLoading: false });
  useProjectCustomFields.mockReturnValue({
    fields: [],
    isLoading: false,
    error: null,
    create: { mutate: vi.fn(), isPending: false, error: null },
    update: { mutate: vi.fn(), isPending: false, error: null },
    remove: { mutate: vi.fn(), isPending: false },
  });
});

describe('ProjectWorkflowPage — phase reordering', () => {
  it('moves the dropped phase into its new slot and persists the whole order', () => {
    renderPage();
    expect(phaseNamesInOrder()).toEqual(['Discovery', 'Build', 'Launch']);

    drop(latestHandlers().phases, 'p3', 'p1');

    // Optimistic overlay: the list reorders before the server answers.
    expect(phaseNamesInOrder()).toEqual(['Launch', 'Discovery', 'Build']);
    expect(phaseReorder).toHaveBeenCalledTimes(1);
    expect(phaseReorder.mock.calls[0][0]).toEqual(['p3', 'p1', 'p2']);
  });

  it('drops the optimistic overlay once the reorder request settles', () => {
    renderPage();
    drop(latestHandlers().phases, 'p3', 'p1');
    expect(phaseNamesInOrder()).toEqual(['Launch', 'Discovery', 'Build']);

    // The server list is authoritative again after onSettled.
    act(() => phaseReorder.mock.calls[0][1].onSettled());
    expect(phaseNamesInOrder()).toEqual(['Discovery', 'Build', 'Launch']);
  });

  it('skips a phase the server dropped while the optimistic order was pending', () => {
    const { replay } = renderPage();
    drop(latestHandlers().phases, 'p3', 'p1');
    expect(phaseNamesInOrder()).toEqual(['Launch', 'Discovery', 'Build']);

    // A concurrent delete removes p2 before the reorder settles.
    setPhases([makePhase({ id: 'p1', name: 'Discovery' }), makePhase({ id: 'p3', name: 'Launch' })]);
    act(() => {
      replay();
    });
    expect(phaseNamesInOrder()).toEqual(['Launch', 'Discovery']);
  });

  it('is a no-op when the phase is released outside any drop target', () => {
    renderPage();
    drop(latestHandlers().phases, 'p3', null);
    expect(phaseReorder).not.toHaveBeenCalled();
    expect(phaseNamesInOrder()).toEqual(['Discovery', 'Build', 'Launch']);
  });

  it('is a no-op when the phase is released back on itself', () => {
    renderPage();
    drop(latestHandlers().phases, 'p2', 'p2');
    expect(phaseReorder).not.toHaveBeenCalled();
    expect(phaseNamesInOrder()).toEqual(['Discovery', 'Build', 'Launch']);
  });

  it('is a no-op when the drop target is not one of the listed phases', () => {
    renderPage();
    drop(latestHandlers().phases, 'p2', 'phase-from-another-project');
    expect(phaseReorder).not.toHaveBeenCalled();
    expect(phaseNamesInOrder()).toEqual(['Discovery', 'Build', 'Launch']);
  });

  it('dims the row that is mid-drag', () => {
    dnd.dragging.add('p2');
    renderPage();
    const region = screen.getByRole('region', { name: /Phases/i });
    const row = within(region).getByRole('button', { name: 'Reorder phase Build' }).closest('li');
    expect(row?.className).toContain('opacity-70');
    const still = within(region)
      .getByRole('button', { name: 'Reorder phase Launch' })
      .closest('li');
    expect(still?.className).not.toContain('opacity-70');
  });
});

describe('ProjectWorkflowPage — status column reordering', () => {
  it('moves the dropped column and saves the full column array in the new order', () => {
    renderPage();
    expect(statusLabelsInOrder()).toEqual(['Backlog', 'Doing', 'Done']);

    drop(latestHandlers().statuses, 'COMPLETE', 'BACKLOG');

    expect(statusLabelsInOrder()).toEqual(['Done', 'Backlog', 'Doing']);
    expect(boardSave).toHaveBeenCalledTimes(1);
    expect(boardSave.mock.calls[0][0].map((c) => c.status)).toEqual([
      'COMPLETE',
      'BACKLOG',
      'IN_PROGRESS',
    ]);
  });

  it('is a no-op for a drop outside a target, onto itself, or onto an unknown column', () => {
    renderPage();
    const { statuses } = latestHandlers();
    drop(statuses, 'COMPLETE', null);
    drop(latestHandlers().statuses, 'COMPLETE', 'COMPLETE');
    drop(latestHandlers().statuses, 'COMPLETE', 'ARCHIVED');
    expect(boardSave).not.toHaveBeenCalled();
    expect(statusLabelsInOrder()).toEqual(['Backlog', 'Doing', 'Done']);
  });

  it('dims the column row that is mid-drag', () => {
    dnd.dragging.add('IN_PROGRESS');
    renderPage();
    const region = screen.getByRole('region', { name: /Statuses/i });
    const row = within(region).getByRole('button', { name: 'Reorder status Doing' }).closest('li');
    expect(row?.className).toContain('opacity-70');
  });
});
