import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BoardScopeInjectionBanner } from './BoardScopeInjectionBanner';
import type { Task } from '@/types';

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
    isCritical: false,
    isComplete: false,
    isSummary: false,
    isMilestone: false,
    status: 'NOT_STARTED',
    assignees: [],
    notes: '',
    ...overrides,
  };
}

beforeEach(() => {
  sessionStorage.clear();
});

describe('BoardScopeInjectionBanner', () => {
  it('renders nothing when no tasks carry scope-change rows', () => {
    const { container } = render(
      <BoardScopeInjectionBanner tasks={[task({}), task({})]} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('counts distinct injected tasks (a task with multiple rows still counts once)', () => {
    render(
      <BoardScopeInjectionBanner
        tasks={[
          task({
            id: 't1',
            sprintScopeChanges: [
              { subtaskName: 'a', itemName: 'a', addedByName: 'PM', addedAt: '2026-01-02', goalImpact: false },
              { subtaskName: 'b', itemName: 'b', addedByName: 'PM', addedAt: '2026-01-03', goalImpact: false },
            ],
          }),
          task({
            id: 't2',
            sprintScopeChanges: [
              { subtaskName: 'c', itemName: 'c', addedByName: 'PM', addedAt: '2026-01-04', goalImpact: false },
            ],
          }),
        ]}
      />,
    );
    expect(
      screen.getByText(/2 tasks added to the active sprint after it started/),
    ).toBeInTheDocument();
  });

  it('surfaces goal-impact subset when any row affects the sprint goal', () => {
    render(
      <BoardScopeInjectionBanner
        tasks={[
          task({
            id: 't1',
            sprintScopeChanges: [
              { subtaskName: 'a', itemName: 'a', addedByName: 'PM', addedAt: '2026-01-02', goalImpact: true },
            ],
          }),
        ]}
      />,
    );
    expect(screen.getByText(/1 affects the sprint goal/)).toBeInTheDocument();
  });

  it('dismisses for the session and stays dismissed across re-mount with same counts', () => {
    const tasks = [
      task({
        id: 't1',
        sprintScopeChanges: [
          { subtaskName: 'a', itemName: 'a', addedByName: 'PM', addedAt: '2026-01-02', goalImpact: false },
        ],
      }),
    ];
    const { unmount, container } = render(<BoardScopeInjectionBanner tasks={tasks} />);
    fireEvent.click(screen.getByLabelText(/dismiss/i));
    expect(container.firstChild).toBeNull();
    unmount();

    const { container: c2 } = render(<BoardScopeInjectionBanner tasks={tasks} />);
    // Stays dismissed for the same (count, goal-impact) signature.
    expect(c2.firstChild).toBeNull();
  });
});
