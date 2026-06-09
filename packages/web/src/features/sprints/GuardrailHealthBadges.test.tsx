import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { GuardrailHealthBadges } from './GuardrailHealthBadges';
import type { Task, ApiSprint } from '@/types';

function task(overrides: Partial<Task>): Task {
  return {
    id: overrides.id ?? `t-${Math.random()}`,
    wbs: overrides.wbs ?? '1',
    name: overrides.name ?? 'Task',
    start: '2026-01-01',
    finish: '2026-01-02',
    duration: overrides.duration ?? 1,
    progress: overrides.progress ?? 0,
    parentId: overrides.parentId ?? null,
    isCritical: overrides.isCritical ?? false,
    isComplete: overrides.isComplete ?? false,
    isSummary: overrides.isSummary ?? false,
    isMilestone: overrides.isMilestone ?? false,
    status: overrides.status ?? 'NOT_STARTED',
    assignees: overrides.assignees ?? [],
    notes: overrides.notes ?? '',
    ...overrides,
  };
}

function sprint(id: string): ApiSprint {
  return {
    id,
    server_version: 1,
    short_id: 'A1',
    short_id_display: 'SP-A1',
    name: 'Sprint 1',
    goal: '',
    notes: '',
    start_date: '2026-01-01',
    finish_date: '2026-01-14',
    state: 'ACTIVE',
    target_milestone: null,
    target_milestone_detail: null,
    capacity_points: null,
    wip_limit: null,
    committed_points: null,
    committed_task_count: null,
    completed_points: null,
    completed_task_count: null,
    completion_ratio_points: null,
    completion_ratio_tasks: null,
    activated_at: '2026-01-01T00:00:00Z',
    closed_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

describe('GuardrailHealthBadges', () => {
  it('renders nothing when all counts are zero', () => {
    const { container } = render(
      <GuardrailHealthBadges
        tasks={[task({ wbs: '1.1', sprintId: 'sp-1' })]}
        activeSprint={sprint('sp-1')}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('counts tasks with no sprint and no phase as orphans (uses outcome copy)', () => {
    render(
      <GuardrailHealthBadges
        tasks={[
          task({ id: 't1', wbs: '', sprintId: null }),
          task({ id: 't2', wbs: '5', sprintId: null }), // wbs="5" alone = phase itself, still "no phase ancestor"
          task({ id: 't3', wbs: '5.1', sprintId: null }), // child of phase → has a phase
          task({ id: 't4', wbs: '', sprintId: null, isSummary: true }), // summary excluded
        ]}
        activeSprint={null}
      />,
    );
    expect(screen.getByText(/2 tasks in no sprint and no phase/)).toBeInTheDocument();
  });

  it('flags parent (summary) tasks assigned to a sprint with warn tone', () => {
    render(
      <GuardrailHealthBadges
        tasks={[
          task({ id: 'sum', isSummary: true, sprintId: 'sp-1', wbs: '1' }),
          task({ id: 'leaf', sprintId: 'sp-1', wbs: '1.1' }),
        ]}
        activeSprint={sprint('sp-1')}
      />,
    );
    // Outcome-language: "parent task", never "summary task" (ADR-0101 §2).
    expect(screen.getByText(/1 parent task in a sprint/)).toBeInTheDocument();
  });

  it('reports phase span only when the active sprint spans 3+ phases', () => {
    const tasks = [
      task({ id: 't1', sprintId: 'sp-1', wbs: '1.1' }),
      task({ id: 't2', sprintId: 'sp-1', wbs: '2.1' }),
      task({ id: 't3', sprintId: 'sp-1', wbs: '3.1' }),
    ];
    render(
      <GuardrailHealthBadges tasks={tasks} activeSprint={sprint('sp-1')} />,
    );
    expect(screen.getByText(/Active sprint spans 3 phases/)).toBeInTheDocument();
  });

  it('does NOT flag phase span below the threshold (avoids noise)', () => {
    const tasks = [
      task({ id: 't1', sprintId: 'sp-1', wbs: '1.1' }),
      task({ id: 't2', sprintId: 'sp-1', wbs: '2.1' }),
    ];
    render(
      <GuardrailHealthBadges tasks={tasks} activeSprint={sprint('sp-1')} />,
    );
    expect(screen.queryByText(/spans/)).not.toBeInTheDocument();
  });
});
