/**
 * Role gating for the task drawer's Dependencies section (#3143).
 *
 * The section had no gate at all: add-predecessor, add-successor and per-edge
 * Remove rendered for every reader, Viewer included, and Remove is the only
 * delete among the five dependency-write surfaces.
 *
 * The band under test is `canAuthorDependencies` (Scheduler+), NOT
 * `canEditTask`/`canEdit`. The two do not nest — a Member authors task content
 * and no edges; a Scheduler authors edges and no task content (ADR-0773 §7) —
 * so a test that only drove one of them would keep passing against a gate that
 * had been re-collapsed onto the wrong predicate. Both bands are pinned below.
 */
import { screen } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { DependenciesSection } from './DependenciesSection';
import { ROLE_VIEWER, ROLE_MEMBER, ROLE_SCHEDULER, ROLE_ADMIN, ROLE_OWNER } from '@/lib/roles';
import type { Task, TaskLink } from '@/types';

const useScheduleTasksMock = vi.hoisted(() => vi.fn());
const useProjectMock = vi.hoisted(() => vi.fn());
const useCurrentUserRoleMock = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useScheduleTasks', () => ({ useScheduleTasks: useScheduleTasksMock }));
vi.mock('@/hooks/useProject', () => ({ useProject: useProjectMock }));
vi.mock('@/hooks/useCurrentUserRole', () => ({ useCurrentUserRole: useCurrentUserRoleMock }));
vi.mock('@/hooks/useDependencyMutations', () => ({
  useCreateDependency: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateDependency: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteDependency: () => ({ mutate: vi.fn(), isPending: false }),
}));

const TASK_A: Task = {
  id: 'task-a',
  wbs: '1.1',
  name: 'Task A',
  start: '2026-06-01',
  finish: '2026-06-05',
  duration: 4,
  progress: 0,
  parentId: null,
  isCritical: false,
  isComplete: false,
  isSummary: false,
  isMilestone: false,
  status: 'NOT_STARTED',
  assignees: [],
  notes: '',
};
const TASK_B: Task = { ...TASK_A, id: 'task-b', wbs: '1.2', name: 'Task B' };

/** One existing FS edge A → B, so the per-edge Remove control has something to render on. */
const LINK: TaskLink = {
  id: 'link-1',
  sourceId: 'task-a',
  targetId: 'task-b',
  type: 'FS',
  lag: 0,
  isCritical: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  useScheduleTasksMock.mockReturnValue({ tasks: [TASK_A, TASK_B], links: [LINK] });
  useProjectMock.mockReturnValue({ data: { program: null } });
  useCurrentUserRoleMock.mockReturnValue({ role: null, isLoading: false, isError: false });
});

function renderSection(userRole: number | null) {
  return renderWithProviders(
    <DependenciesSection taskId="task-b" projectId="proj-1" userRole={userRole} />,
  );
}

/** The three write controls the section exposes, by accessible name. */
function writeControls() {
  return {
    addPred: screen.queryByRole('button', { name: 'Add predecessor' }),
    addSucc: screen.queryByRole('button', { name: 'Add successor' }),
    remove: screen.queryByRole('button', { name: /Remove dependency on/ }),
  };
}

describe('DependenciesSection — dependency authoring band (#3143, ADR-0773 §7)', () => {
  it.each([
    ['Scheduler', ROLE_SCHEDULER],
    ['Admin', ROLE_ADMIN],
    ['Owner', ROLE_OWNER],
  ])('offers add and remove to a %s', (_label, role) => {
    renderSection(role);
    const c = writeControls();
    expect(c.addPred).toBeInTheDocument();
    expect(c.addSucc).toBeInTheDocument();
    expect(c.remove).toBeInTheDocument();
  });

  it.each([
    ['Viewer', ROLE_VIEWER],
    ['Member', ROLE_MEMBER],
  ])('offers no write control at all to a %s', (_label, role) => {
    renderSection(role);
    const c = writeControls();
    expect(c.addPred).not.toBeInTheDocument();
    expect(c.addSucc).not.toBeInTheDocument();
    expect(c.remove).not.toBeInTheDocument();
  });

  it('keeps the edge readable for a Viewer — gated, not hidden', () => {
    renderSection(ROLE_VIEWER);
    // The section still lists the edge and its relation type as text, so a
    // Viewer loses the controls and none of the information.
    expect(screen.getByText(/1\.1 — Task A/)).toBeInTheDocument();
    expect(screen.getByText(/Finish-to-Start/)).toBeInTheDocument();
    // …and specifically not as an editable control.
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
  });

  it('withholds the controls while the role read is still in flight', () => {
    // Pessimistic on loading: absent for a beat beats flashing on and then 403ing.
    useCurrentUserRoleMock.mockReturnValue({ role: null, isLoading: true, isError: false });
    renderSection(null);
    expect(writeControls().addPred).not.toBeInTheDocument();
  });

  it('restores the controls when the role read FAILED rather than resolving', () => {
    // `retry: false` makes one dropped request terminal. Treating that as a
    // refusal would strip a Scheduler's only keyboard route to dependency
    // authoring for the life of the page; the server still enforces (#2961).
    useCurrentUserRoleMock.mockReturnValue({ role: null, isLoading: false, isError: true });
    renderSection(null);
    expect(writeControls().addPred).toBeInTheDocument();
  });
});
