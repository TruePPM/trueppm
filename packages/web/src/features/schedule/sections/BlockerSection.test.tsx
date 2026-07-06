import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type { Task } from '@/types';
import { BlockerSection } from './BlockerSection';
import { useBlockerOutboxStore } from '@/features/blocker/offline/blockerOutboxStore';
import type { QueuedBlockerOp } from '@/features/blocker/offline/blockerQueue';

const mutate = vi.fn();

vi.mock('@/hooks/useTaskMutations', () => ({
  useUpdateTask: () => ({ mutate, isPending: false }),
}));

// Controllable connectivity — flip `onlineState.value` to exercise the offline path.
const onlineState = vi.hoisted(() => ({ value: true }));
vi.mock('@/hooks/useOnlineStatus', () => ({
  useOnlineStatus: () => onlineState.value,
}));

let TASKS: Partial<Task>[] = [];
vi.mock('@/hooks/useScheduleTasks', () => ({
  useScheduleTasks: () => ({ tasks: TASKS }),
}));

function setTask(over: Partial<Task>) {
  TASKS = [{ id: 'task-1', name: 'Build login', ...over }];
}

/** Seed the reactive blocker outbox so the pending badge renders (bypasses IndexedDB). */
function seedPending(op: Partial<QueuedBlockerOp>) {
  const full: QueuedBlockerOp = {
    projectId: 'proj-1',
    taskId: 'task-1',
    kind: 'flag',
    reason: 'inspector no-show',
    blockerType: 'vendor',
    blockingTask: null,
    baseServerVersion: 1,
    wasFlagged: false,
    queuedAt: 100,
    ...op,
  };
  useBlockerOutboxStore.setState({ opsByTask: { [full.taskId]: full } });
}

afterEach(() => {
  vi.clearAllMocks();
  TASKS = [];
  onlineState.value = true;
  useBlockerOutboxStore.setState({ opsByTask: {}, hydrated: false, lastSynced: null });
});

function renderSection(canEdit = false) {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <BlockerSection taskId="task-1" projectId="proj-1" canEdit={canEdit} />
    </QueryClientProvider>,
  );
}

describe('BlockerSection — not flagged', () => {
  it('shows the flag affordance and reveals the form', () => {
    setTask({ blockedAgeSeconds: null, blockedReason: '', blockerType: '' });
    renderSection(true);
    expect(screen.getByText('Not blocked')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /flag as blocked/i }));
    expect(screen.getByLabelText('Reason')).toBeInTheDocument();
  });

  it('requires a reason to flag (type stays optional)', () => {
    setTask({ blockedAgeSeconds: null, blockedReason: '', blockerType: '' });
    renderSection(true);
    fireEvent.click(screen.getByRole('button', { name: /flag as blocked/i }));
    const flagBtn = screen.getByRole('button', { name: 'Flag blocked' });
    expect(flagBtn).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Waiting on permit' } });
    expect(flagBtn).toBeEnabled();
    fireEvent.click(flagBtn);
    expect(mutate).toHaveBeenCalledTimes(1);
    const payload = mutate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      id: 'task-1',
      projectId: 'proj-1',
      blocked_reason: 'Waiting on permit',
      blocker_type: '', // optional — not chosen
      blocking_task: null,
    });
  });

  it('sends the chosen type when one is picked', () => {
    setTask({ blockedAgeSeconds: null, blockedReason: '', blockerType: '' });
    renderSection(true);
    fireEvent.click(screen.getByRole('button', { name: /flag as blocked/i }));
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'vendor late' } });
    fireEvent.change(screen.getByLabelText(/Type/), { target: { value: 'vendor' } });
    fireEvent.click(screen.getByRole('button', { name: 'Flag blocked' }));
    expect(mutate.mock.calls[0][0]).toMatchObject({ blocker_type: 'vendor' });
  });

  it('labels the soft link as informational and warns it does not move dates', () => {
    setTask({ blockedAgeSeconds: null, blockedReason: '', blockerType: '' });
    renderSection(true);
    fireEvent.click(screen.getByRole('button', { name: /flag as blocked/i }));
    expect(screen.getByText(/Related task/)).toBeInTheDocument();
    expect(screen.getByText(/informational/)).toBeInTheDocument();
    expect(screen.getByText(/does not move schedule dates/i)).toBeInTheDocument();
  });
});

describe('BlockerSection — flagged', () => {
  it('shows team-visible signals + editable reason for the assignee', () => {
    setTask({
      blockedAgeSeconds: 3600,
      blockedReason: 'Waiting on the permit office',
      blockerType: 'vendor',
      blockedBy: { id: 'u1', username: 'alex' },
    });
    renderSection(true);
    expect(screen.getByText('Blocked')).toBeInTheDocument();
    // "External vendor" appears as both the at-a-glance chip and the selected
    // <option> in the editable picker — assert at least the chip is present.
    expect(screen.getAllByText('External vendor').length).toBeGreaterThan(0);
    expect(screen.getByText('1h blocked')).toBeInTheDocument();
    expect(screen.getByText(/flagged by alex/)).toBeInTheDocument();
    // The assignee can read + edit the reason.
    expect(screen.getByLabelText('Reason')).toHaveValue('Waiting on the permit office');
  });

  it('shows a privacy notice instead of the reason when the viewer cannot read it', () => {
    setTask({
      blockedAgeSeconds: 7200,
      blockedReason: undefined, // server gated it out
      blockerType: 'decision',
      blockedBy: { id: 'u1', username: 'sam' },
    });
    renderSection();
    expect(screen.getByText(/private to the assignee/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('Reason')).not.toBeInTheDocument();
    // Triage signals still render (chip + selected option).
    expect(screen.getAllByText('Decision needed').length).toBeGreaterThan(0);
  });

  it('annotates the related task as informational in the read-only view (issue 1156)', () => {
    // Non-editor (Viewer / non-assignee) read view: the soft link shows as a
    // plain name, now with the "does not affect the schedule" caveat so it can't
    // be mistaken for a CPM dependency.
    TASKS = [
      {
        id: 'task-1',
        name: 'Build login',
        blockedAgeSeconds: 3600,
        blockedReason: undefined, // gated — non-assignee read view
        blockerType: 'dependency',
        blockingTask: 't9',
        blockedBy: { id: 'u1', username: 'sam' },
      },
      { id: 't9', name: 'Permit approval' },
    ];
    renderSection(false);
    expect(screen.getByText('Related task')).toBeInTheDocument();
    expect(screen.getByText('Permit approval')).toBeInTheDocument();
    expect(screen.getByText(/does not affect the schedule/i)).toBeInTheDocument();
  });

  it('unblocks by clearing the reason', () => {
    setTask({
      blockedAgeSeconds: 3600,
      blockedReason: 'stuck',
      blockerType: 'vendor',
      blockedBy: { id: 'u1', username: 'alex' },
    });
    renderSection(true);
    fireEvent.click(screen.getByRole('button', { name: 'Unblock' }));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toMatchObject({
      id: 'task-1',
      projectId: 'proj-1',
      blocked_reason: '',
    });
  });
});

describe('BlockerSection — offline (ADR-0247)', () => {
  it('queues the flag instead of a live write and announces it', () => {
    onlineState.value = false;
    setTask({ blockedAgeSeconds: null, blockedReason: '', blockerType: '' });
    renderSection(true);
    fireEvent.click(screen.getByRole('button', { name: /flag as blocked/i }));
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'inspector no-show' } });
    // Both the form and the flagged-state action rows advertise the offline behavior.
    expect(
      screen.getAllByText(/saved and synced when you reconnect/i).length,
    ).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Flag blocked' }));
    // No live PATCH offline; the durable queue owns the write.
    expect(mutate).not.toHaveBeenCalled();
    expect(useBlockerOutboxStore.getState().opsByTask['task-1']?.kind).toBe('flag');
    expect(screen.getByText(/Blocker flagged\. Queued/i)).toBeInTheDocument();
  });

  it('queues an unblock instead of a live write when offline', () => {
    onlineState.value = false;
    setTask({
      blockedAgeSeconds: 3600,
      blockedReason: 'stuck',
      blockerType: 'vendor',
      blockedBy: { id: 'u1', username: 'alex' },
    });
    renderSection(true);
    fireEvent.click(screen.getByRole('button', { name: 'Unblock' }));
    expect(mutate).not.toHaveBeenCalled();
    expect(useBlockerOutboxStore.getState().opsByTask['task-1']?.kind).toBe('unblock');
    expect(screen.getByText(/Unblock queued/i)).toBeInTheDocument();
  });

  it('shows a "queued" label + pending badge for a fresh offline flag', () => {
    // A fresh flag has no server-stamped age yet — the row reads "queued", not a duration.
    seedPending({ kind: 'flag', wasFlagged: false });
    setTask({
      blockedAgeSeconds: 0,
      blockedReason: 'inspector no-show',
      blockerType: 'vendor',
    });
    renderSection(true);
    expect(screen.getByText('queued')).toBeInTheDocument();
    expect(
      screen.getByLabelText(/Blocker flag queued — it will save when you reconnect/i),
    ).toBeInTheDocument();
  });

  it('keeps the pending affordance on the flag control after a queued unblock', () => {
    // A queued unblock optimistically clears the row, so the badge rides the affordance.
    seedPending({ kind: 'unblock' });
    setTask({ blockedAgeSeconds: null, blockedReason: '', blockerType: '' });
    renderSection(true);
    expect(screen.getByText('Not blocked')).toBeInTheDocument();
    expect(
      screen.getByLabelText(/Unblock queued — it will save when you reconnect/i),
    ).toBeInTheDocument();
  });

  it('still writes live when online (no regression to the default path)', () => {
    setTask({ blockedAgeSeconds: null, blockedReason: '', blockerType: '' });
    renderSection(true);
    fireEvent.click(screen.getByRole('button', { name: /flag as blocked/i }));
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'live path' } });
    fireEvent.click(screen.getByRole('button', { name: 'Flag blocked' }));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(useBlockerOutboxStore.getState().opsByTask['task-1']).toBeUndefined();
  });
});
