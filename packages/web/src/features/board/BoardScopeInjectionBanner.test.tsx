import { describe, it, expect, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders as render } from '@/test/utils';
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

  it('adds a pending-acceptance line when pendingCount > 0 (ADR-0102)', () => {
    render(
      <BoardScopeInjectionBanner
        tasks={[
          task({
            id: 't1',
            sprintScopeChanges: [
              { id: 'sc1', subtaskName: 'a', itemName: 'a', addedByName: 'PM', addedAt: '2026-01-02', goalImpact: false, status: 'pending' },
            ],
          }),
        ]}
        pendingCount={2}
      />,
    );
    expect(screen.getByText(/2 pending acceptance/)).toBeInTheDocument();
  });

  it('shows the Review button only for a team-owned actor (canManageScope)', () => {
    const tasks = [
      task({
        id: 't1',
        sprintScopeChanges: [
          { id: 'sc1', subtaskName: 'a', itemName: 'a', addedByName: 'PM', addedAt: '2026-01-02', goalImpact: false, status: 'pending' },
        ],
      }),
    ];
    // Not a manager → no Review button even with pending items.
    const { unmount } = render(
      <BoardScopeInjectionBanner tasks={tasks} pendingCount={1} canManageScope={false} onReview={() => {}} />,
    );
    expect(screen.queryByRole('button', { name: /review/i })).not.toBeInTheDocument();
    unmount();
    sessionStorage.clear();

    // Manager → Review (N) button fires onReview.
    let clicked = false;
    render(
      <BoardScopeInjectionBanner
        tasks={tasks}
        pendingCount={1}
        canManageScope
        onReview={() => {
          clicked = true;
        }}
      />,
    );
    const btn = screen.getByRole('button', { name: /review \(1\)/i });
    fireEvent.click(btn);
    expect(clicked).toBe(true);
  });

  it('stays a status region (notice, never an alert) even with pending items', () => {
    render(
      <BoardScopeInjectionBanner
        tasks={[
          task({
            id: 't1',
            sprintScopeChanges: [
              { id: 'sc1', subtaskName: 'a', itemName: 'a', addedByName: 'PM', addedAt: '2026-01-02', goalImpact: false, status: 'pending' },
            ],
          }),
        ]}
        pendingCount={1}
      />,
    );
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  // Rule 228 / WCAG 2.5.5 (#1801): the dismiss × keeps a 44px touch target on
  // phones, compacting to 24px only at `md:`. Regression guarded: compaction
  // keyed off `sm:` (fires at 375px) shrank the target to 24px.
  it('the dismiss control keeps a 44px touch target, compacting only at md:', () => {
    render(
      <BoardScopeInjectionBanner
        tasks={[
          task({
            id: 't1',
            sprintScopeChanges: [
              { subtaskName: 'a', itemName: 'a', addedByName: 'PM', addedAt: '2026-01-02', goalImpact: false },
            ],
          }),
        ]}
      />,
    );
    const cls = screen.getByLabelText(/dismiss/i).className;
    expect(cls).toContain('min-h-[44px]');
    expect(cls).toContain('min-w-[44px]');
    expect(cls).toContain('md:min-h-0');
    expect(cls).not.toContain('sm:min-h-0');
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
