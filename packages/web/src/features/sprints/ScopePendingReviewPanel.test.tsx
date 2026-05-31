import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ScopePendingReviewPanel } from './ScopePendingReviewPanel';
import type { Task } from '@/types';

const { postMock } = vi.hoisted(() => ({
  postMock: vi.fn().mockResolvedValue({ data: { pending_count: 0 } }),
}));

vi.mock('@/api/client', () => ({ apiClient: { post: postMock } }));

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}

function task(overrides: Partial<Task>): Task {
  return {
    id: overrides.id ?? 't1',
    wbs: '1',
    name: overrides.name ?? 'Task',
    start: '2026-01-01',
    finish: '2026-01-02',
    duration: 1,
    progress: 0,
    parentId: null,
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

const pendingTask = task({
  id: 't1',
  name: 'Urgent hotfix',
  sprintPending: true,
  sprintScopeChanges: [
    {
      id: 'sc-1',
      subtaskName: 'Urgent hotfix',
      itemName: 'Urgent hotfix',
      addedByName: 'PM',
      addedAt: '2026-01-02',
      goalImpact: false,
      status: 'pending',
    },
  ],
});

describe('ScopePendingReviewPanel (ADR-0102 §5)', () => {
  beforeEach(() => postMock.mockClear());

  it('golden path: single Accept POSTs the scope-change accept endpoint', async () => {
    render(
      <ScopePendingReviewPanel
        projectId="p1"
        sprintId="s1"
        tasks={[pendingTask]}
        onClose={() => {}}
      />,
      { wrapper },
    );
    fireEvent.click(screen.getByRole('button', { name: /Accept Urgent hotfix into the sprint/ }));
    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/scope-changes/sc-1/accept/'));
  });

  it('bulk reject goes through a confirm step before POSTing (rule 150)', async () => {
    render(
      <ScopePendingReviewPanel
        projectId="p1"
        sprintId="s1"
        tasks={[pendingTask]}
        onClose={() => {}}
      />,
      { wrapper },
    );
    // Footer "Reject all" opens a confirm dialog — it must NOT post directly.
    fireEvent.click(screen.getByRole('button', { name: 'Reject all' }));
    expect(postMock).not.toHaveBeenCalled();
    // The confirm dialog appears; its confirm button fires the bulk endpoint.
    const dialog = screen.getByRole('dialog', { name: /Reject all/ });
    const confirmBtn = dialog.querySelectorAll('button');
    fireEvent.click(confirmBtn[confirmBtn.length - 1]); // last button = "Reject all" confirm
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/sprints/s1/scope-changes/reject/', {}),
    );
  });

  it('empty state: no pending items shows the all-clear message and no controls', () => {
    render(
      <ScopePendingReviewPanel
        projectId="p1"
        sprintId="s1"
        tasks={[task({ id: 't2', sprintPending: false })]}
        onClose={() => {}}
      />,
      { wrapper },
    );
    expect(
      screen.getByText(/No items pending acceptance/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept all' })).not.toBeInTheDocument();
  });

  it('offline disables the accept/reject controls (rule 152 — never queue)', () => {
    render(
      <ScopePendingReviewPanel
        projectId="p1"
        sprintId="s1"
        tasks={[pendingTask]}
        offline
        onClose={() => {}}
      />,
      { wrapper },
    );
    expect(
      screen.getByRole('button', { name: /Accept Urgent hotfix into the sprint/ }),
    ).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Accept all' })).toBeDisabled();
  });
});
