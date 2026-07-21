/**
 * Tests for <RiskLinkedTasksSection> — the risk → mitigation-task handoff in the
 * read-only risk detail view (#2156, ADR-0566). Covers: rendering linked tasks
 * and opening them in the global task drawer (closing the risk drawer first),
 * the "Create mitigation task" name prefill + no-sprint/no-assignee payload +
 * full-set link PATCH, the partial-failure recovery message, role gating, the
 * empty state, and the unavailable-task fallback.
 */
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { RiskLinkedTasksSection } from './RiskLinkedTasksSection';
import type { Risk } from '@/api/types';

type CreateTaskOpts = {
  onSuccess: (created: { id: string }) => void;
  onError: (err: Error) => void;
};
type UpdateRiskOpts = { onSuccess: () => void; onError: (err: Error) => void };
type CreateTaskPayload = { name: string; duration: number };
type UpdateRiskVars = { projectId: string; id: string; data: { tasks: string[] } };

const { useScheduleTasksMock, useCurrentUserRoleMock, useCreateTaskMock, useUpdateRiskMock, openTaskMock, createTaskMutate, updateRiskMutate } =
  vi.hoisted(() => ({
    useScheduleTasksMock: vi.fn(),
    useCurrentUserRoleMock: vi.fn(),
    useCreateTaskMock: vi.fn(),
    useUpdateRiskMock: vi.fn(),
    openTaskMock: vi.fn(),
    createTaskMutate: vi.fn<(payload: CreateTaskPayload, opts: CreateTaskOpts) => void>(),
    updateRiskMutate: vi.fn<(vars: UpdateRiskVars, opts: UpdateRiskOpts) => void>(),
  }));

vi.mock('@/hooks/useScheduleTasks', () => ({ useScheduleTasks: useScheduleTasksMock }));
vi.mock('@/hooks/useCurrentUserRole', () => ({ useCurrentUserRole: useCurrentUserRoleMock }));
vi.mock('@/hooks/useTaskMutations', () => ({ useCreateTask: useCreateTaskMock }));
vi.mock('@/hooks/useRisks', () => ({ useUpdateRisk: useUpdateRiskMock }));
vi.mock('@/stores/taskDrawerStore', () => ({
  useTaskDrawerStore: (sel: (s: { openTask: unknown }) => unknown) => sel({ openTask: openTaskMock }),
}));

// ROLE ordinals: VIEWER=0, MEMBER=100. canEditTask/canEditRisk need MEMBER+.
const MEMBER = 100;
const VIEWER = 0;

function makeTask(id: string, name: string, over: Record<string, unknown> = {}) {
  return { id, name, status: 'IN_PROGRESS', isSummary: false, isMilestone: false, wbs: '', shortId: '', ...over };
}

function makeRisk(over: Partial<Risk> = {}): Risk {
  return {
    id: 'risk-1',
    short_id: '7',
    short_id_display: 'R-007',
    qualified_id: 'R-007',
    server_version: 1,
    project: 'p1',
    title: 'Vendor outage',
    description: '',
    status: 'MITIGATING',
    probability: 4,
    impact: 5,
    severity: 20,
    owner: null,
    created_by: null,
    created_at: '2026-01-01',
    updated_at: '2026-01-02',
    tasks: [],
    notes: '',
    ...over,
  } as Risk;
}

function renderSection(risk: Risk, onCloseDrawer = vi.fn()) {
  render(<RiskLinkedTasksSection projectId="p1" risk={risk} onCloseDrawer={onCloseDrawer} />);
  return { onCloseDrawer };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  useScheduleTasksMock.mockReturnValue({
    tasks: [makeTask('t1', 'Patch the firewall'), makeTask('t2', 'Rotate credentials')],
    links: [],
    isLoading: false,
    error: null,
  });
  useCurrentUserRoleMock.mockReturnValue({ role: MEMBER, roleLabel: 'Member', isLoading: false });
  useCreateTaskMock.mockReturnValue({ mutate: createTaskMutate, isPending: false });
  useUpdateRiskMock.mockReturnValue({ mutate: updateRiskMutate, isPending: false });
});

describe('<RiskLinkedTasksSection> linked list', () => {
  it('renders each linked task with its status and opens it after closing the drawer', () => {
    const { onCloseDrawer } = renderSection(makeRisk({ tasks: ['t1'] }));
    const row = screen.getByRole('button', { name: /Open task Patch the firewall/ });
    expect(row).toBeInTheDocument();

    fireEvent.click(row);
    // Risk drawer closes first…
    expect(onCloseDrawer).toHaveBeenCalledTimes(1);
    expect(openTaskMock).not.toHaveBeenCalled();
    // …then the task drawer opens on the next tick with the full Task object.
    act(() => {
      vi.runAllTimers();
    });
    expect(openTaskMock).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }), 'p1');
  });

  it('renders an unresolved linked id as a non-interactive "Unavailable task" chip', () => {
    renderSection(makeRisk({ tasks: ['ghost'] }));
    expect(screen.getByText('Unavailable task')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Open task/ })).not.toBeInTheDocument();
  });

  it('shows the empty prompt with a create hint for a Member', () => {
    renderSection(makeRisk({ tasks: [] }));
    expect(screen.getByText(/No tasks linked yet\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create mitigation task from this risk' })).toBeInTheDocument();
  });
});

describe('<RiskLinkedTasksSection> role gating', () => {
  it('hides the create button for a Viewer', () => {
    useCurrentUserRoleMock.mockReturnValue({ role: VIEWER, roleLabel: 'Viewer', isLoading: false });
    renderSection(makeRisk({ tasks: [] }));
    expect(
      screen.queryByRole('button', { name: 'Create mitigation task from this risk' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('No tasks linked yet.')).toBeInTheDocument();
  });
});

describe('<RiskLinkedTasksSection> create mitigation task', () => {
  it('prefills the task name from the risk title and creates it unscheduled + unassigned', () => {
    renderSection(makeRisk({ title: 'Vendor outage', tasks: [] }));
    fireEvent.click(screen.getByRole('button', { name: 'Create mitigation task from this risk' }));

    expect(createTaskMutate).toHaveBeenCalledTimes(1);
    const [payload] = createTaskMutate.mock.calls[0];
    expect(payload).toEqual({ name: 'Mitigate: Vendor outage', duration: 1 });
    // No sprint, no assignee keys — the task must not be sprinted or assigned.
    expect(payload).not.toHaveProperty('sprint');
    expect(payload).not.toHaveProperty('assignee');
  });

  it('truncates the derived name to the 512-char Task.name limit', () => {
    const longTitle = 'x'.repeat(600);
    renderSection(makeRisk({ title: longTitle, tasks: [] }));
    fireEvent.click(screen.getByRole('button', { name: 'Create mitigation task from this risk' }));
    const [payload] = createTaskMutate.mock.calls[0];
    expect(payload.name.length).toBe(512);
    expect(payload.name.startsWith('Mitigate: ')).toBe(true);
  });

  it('links the new task via a PATCH carrying the full existing id set plus the new id', () => {
    // Existing links must be re-sent — the serializer replaces the M2M set.
    createTaskMutate.mockImplementation((_p: unknown, opts: CreateTaskOpts) => opts.onSuccess({ id: 'new-task' }));
    renderSection(makeRisk({ tasks: ['t1'] }));
    fireEvent.click(screen.getByRole('button', { name: 'Create mitigation task from this risk' }));

    expect(updateRiskMutate).toHaveBeenCalledTimes(1);
    const [vars] = updateRiskMutate.mock.calls[0];
    expect(vars).toEqual(
      expect.objectContaining({ projectId: 'p1', id: 'risk-1', data: { tasks: ['t1', 'new-task'] } }),
    );
  });

  it('confirms the unscheduled outcome on success', () => {
    createTaskMutate.mockImplementation((_p: unknown, opts: CreateTaskOpts) => opts.onSuccess({ id: 'new-task' }));
    updateRiskMutate.mockImplementation((_v: unknown, opts: UpdateRiskOpts) => opts.onSuccess());
    renderSection(makeRisk({ tasks: [] }));
    fireEvent.click(screen.getByRole('button', { name: 'Create mitigation task from this risk' }));
    expect(screen.getByRole('status')).toHaveTextContent(
      'Mitigation task created — unscheduled and not in any sprint.',
    );
  });

  it('shows a recovery message when the task is created but the link PATCH fails', () => {
    createTaskMutate.mockImplementation((_p: unknown, opts: CreateTaskOpts) => opts.onSuccess({ id: 'new-task' }));
    updateRiskMutate.mockImplementation((_v: unknown, opts: UpdateRiskOpts) => opts.onError(new Error('boom')));
    renderSection(makeRisk({ tasks: [] }));
    fireEvent.click(screen.getByRole('button', { name: 'Create mitigation task from this risk' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      "Task created but couldn't link it to this risk",
    );
  });

  it('shows an error when task creation itself fails', () => {
    createTaskMutate.mockImplementation((_p: unknown, opts: CreateTaskOpts) => opts.onError(new Error('boom')));
    renderSection(makeRisk({ tasks: [] }));
    fireEvent.click(screen.getByRole('button', { name: 'Create mitigation task from this risk' }));
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't create the task. Please try again.");
    expect(updateRiskMutate).not.toHaveBeenCalled();
  });
});
