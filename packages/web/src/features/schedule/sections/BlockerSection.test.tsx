import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import type { Task } from '@/types';
import { BlockerSection } from './BlockerSection';

const mutate = vi.fn();

vi.mock('@/hooks/useTaskMutations', () => ({
  useUpdateTask: () => ({ mutate, isPending: false }),
}));

let TASKS: Partial<Task>[] = [];
vi.mock('@/hooks/useScheduleTasks', () => ({
  useScheduleTasks: () => ({ tasks: TASKS }),
}));

function setTask(over: Partial<Task>) {
  TASKS = [{ id: 'task-1', name: 'Build login', ...over }];
}

afterEach(() => {
  vi.clearAllMocks();
  TASKS = [];
});

function renderSection() {
  return render(<BlockerSection taskId="task-1" projectId="proj-1" />);
}

describe('BlockerSection — not flagged', () => {
  it('shows the flag affordance and reveals the form', () => {
    setTask({ blockedAgeSeconds: null, blockedReason: '', blockerType: '' });
    renderSection();
    expect(screen.getByText('Not blocked')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /flag as blocked/i }));
    expect(screen.getByLabelText('Reason')).toBeInTheDocument();
  });

  it('requires a reason to flag (type stays optional)', () => {
    setTask({ blockedAgeSeconds: null, blockedReason: '', blockerType: '' });
    renderSection();
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
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: /flag as blocked/i }));
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'vendor late' } });
    fireEvent.change(screen.getByLabelText(/Type/), { target: { value: 'vendor' } });
    fireEvent.click(screen.getByRole('button', { name: 'Flag blocked' }));
    expect(mutate.mock.calls[0][0]).toMatchObject({ blocker_type: 'vendor' });
  });

  it('labels the soft link as informational and warns it does not move dates', () => {
    setTask({ blockedAgeSeconds: null, blockedReason: '', blockerType: '' });
    renderSection();
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
    renderSection();
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

  it('unblocks by clearing the reason', () => {
    setTask({
      blockedAgeSeconds: 3600,
      blockedReason: 'stuck',
      blockerType: 'vendor',
      blockedBy: { id: 'u1', username: 'alex' },
    });
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: 'Unblock' }));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toMatchObject({
      id: 'task-1',
      projectId: 'proj-1',
      blocked_reason: '',
    });
  });
});
