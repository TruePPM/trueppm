import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type { Task } from '@/types';
import { ROLE_MEMBER, ROLE_VIEWER } from '@/lib/roles';
import { BlockerSection } from './BlockerSection';
import { useBlockerOutboxStore } from '@/features/blocker/offline/blockerOutboxStore';
import type { QueuedBlockerOp } from '@/features/blocker/offline/blockerQueue';
import { useDrawerSectionStore, revealKey } from '@/stores/drawerSectionStore';

/** The PATCH payload shape `BlockerSection` hands to `useUpdateTask().mutate`. */
type UpdateTaskVars = {
  id: string;
  projectId: string;
  blocked_reason?: string;
  blocker_type?: string;
  blocking_task?: string | null;
};
type MutateOptions = { onSuccess?: () => void };

const mutate = vi.fn<(vars: UpdateTaskVars, options?: MutateOptions) => void>();

/** The most recent `updateTask` call — payload plus its success callback. */
function lastMutate(): { vars: UpdateTaskVars; options: MutateOptions | undefined } {
  const call = mutate.mock.calls.at(-1);
  if (!call) throw new Error('updateTask was never called');
  return { vars: call[0], options: call[1] };
}

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
  useDrawerSectionStore.setState({ overrides: {}, revealed: {} });
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
    // The queued unblock clears the flag, so ADR-0605 progressive disclosure would
    // fold this section (and its pending badge) behind "Add detail". Reveal it so
    // the badge stays visible until the write syncs (#2348).
    expect(useDrawerSectionStore.getState().revealed[revealKey('task-1', 'blocker')]).toBe(true);
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

/** Render with explicit capability inputs (server verdict and/or raw role). */
function renderWith(props: { canEdit?: boolean; userRole?: number | null } = {}) {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <BlockerSection taskId="task-1" projectId="proj-1" {...props} />
    </QueryClientProvider>,
  );
}

/** A task already flagged blocked, readable reason, one hour old. */
function setFlaggedTask(over: Partial<Task> = {}) {
  setTask({
    blockedAgeSeconds: 3600,
    blockedReason: 'stuck',
    blockerType: 'vendor',
    blockedBy: { id: 'u1', username: 'alex' },
    ...over,
  });
}

describe('BlockerSection — guards and capability fallback', () => {
  it('renders nothing when the task is not in the loaded schedule', () => {
    TASKS = [{ id: 'other-task', name: 'Something else' }];
    const { container } = renderWith({ canEdit: true });
    expect(container).toBeEmptyDOMElement();
  });

  it('falls back to the client role rule when the server verdict is absent (Viewer)', () => {
    setTask({ blockedAgeSeconds: null, blockedReason: '', blockerType: '' });
    renderWith({ userRole: ROLE_VIEWER });
    expect(screen.getByText('Not blocked')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /flag as blocked/i })).toBeNull();
  });

  it('falls back to the client role rule when the server verdict is absent (Member)', () => {
    setTask({ blockedAgeSeconds: null, blockedReason: '', blockerType: '' });
    renderWith({ userRole: ROLE_MEMBER });
    expect(screen.getByRole('button', { name: /flag as blocked/i })).toBeInTheDocument();
  });

  it('lets the server verdict override a role that would otherwise allow edits', () => {
    setTask({ blockedAgeSeconds: null, blockedReason: '', blockerType: '' });
    renderWith({ canEdit: false, userRole: ROLE_MEMBER });
    expect(screen.queryByRole('button', { name: /flag as blocked/i })).toBeNull();
  });
});

describe('BlockerSection — read-only view', () => {
  it('offers no write control at all on an unflagged task', () => {
    setTask({ blockedAgeSeconds: null, blockedReason: '', blockerType: '' });
    renderWith({ canEdit: false });
    expect(screen.getByText('Not blocked')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders a readable reason as static text, never an editable field', () => {
    setFlaggedTask({ blockedAgeSeconds: 90_000, blockedReason: 'Waiting on the permit office' });
    renderWith({ canEdit: false });
    expect(screen.getByText('Reason')).toBeInTheDocument();
    expect(screen.getByText('Waiting on the permit office')).toBeInTheDocument();
    expect(screen.queryByLabelText('Reason')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Unblock' })).toBeNull();
    // 90000s = 25h → coarse "1d 1h" label.
    expect(screen.getByText('1d 1h blocked')).toBeInTheDocument();
    expect(screen.getByText(/flagged by alex/)).toBeInTheDocument();
  });

  it('omits the type chip and the "flagged by" line when the server did not stamp them', () => {
    setFlaggedTask({ blockedAgeSeconds: 60, blockerType: '', blockedBy: null });
    renderWith({ canEdit: false });
    expect(screen.getByText('Blocked')).toBeInTheDocument();
    expect(screen.getByText('just now')).toBeInTheDocument();
    expect(screen.queryByText(/flagged by/)).toBeNull();
    expect(screen.queryByText('External vendor')).toBeNull();
  });

  it('omits the related-task block when the soft link points outside the loaded tasks', () => {
    setFlaggedTask({ blockingTask: 'not-loaded' });
    renderWith({ canEdit: false });
    expect(screen.queryByText('Related task')).toBeNull();
  });

  it('shows "queued" + the pending badge for a fresh offline flag (issue 2584)', () => {
    // A viewer has no write control on the task, so the queued signal is the only
    // affordance that reveals a blocker hasn't reached the server yet — it must
    // render identically to the editor's copy, not fall back to a bare "Blocked"
    // with no age. This is the state that had no coverage before #2584.
    seedPending({ kind: 'flag', wasFlagged: false });
    setTask({ blockedAgeSeconds: 0, blockedReason: undefined, blockerType: 'vendor' });
    renderWith({ canEdit: false });
    expect(screen.getByText('queued')).toBeInTheDocument();
    expect(
      screen.getByLabelText(/Blocker flag queued — it will save when you reconnect/i),
    ).toBeInTheDocument();
  });
});

describe('BlockerSection — saving changes to an existing flag', () => {
  it('enables Save only once a draft differs, then patches the type', () => {
    setFlaggedTask();
    renderWith({ canEdit: true });
    const save = screen.getByRole('button', { name: 'Save changes' });
    expect(save).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/Type/), { target: { value: 'resource' } });
    expect(save).toBeEnabled();
    fireEvent.click(save);

    expect(lastMutate().vars).toMatchObject({
      id: 'task-1',
      projectId: 'proj-1',
      blocked_reason: 'stuck',
      blocker_type: 'resource',
      blocking_task: null,
    });
  });

  it('treats a flag with no type and no link as clean until something changes', () => {
    // Neither field is stamped at all (absent, not empty string) — the drafts must
    // fall back to "" so Save stays disabled instead of reading as dirty on mount.
    setTask({ blockedAgeSeconds: 3600, blockedReason: 'stuck' });
    TASKS = [...TASKS, { id: 't9', name: 'Permit approval' }];
    renderWith({ canEdit: true });
    expect(screen.getByLabelText<HTMLSelectElement>(/Type/).value).toBe('');
    expect(screen.getByLabelText<HTMLSelectElement>(/Related task/).value).toBe('');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/Related task/), { target: { value: 't9' } });
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
  });

  it('treats a reason edit as dirty and sends the new text', () => {
    setFlaggedTask();
    renderWith({ canEdit: true });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'still stuck' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(lastMutate().vars).toMatchObject({ blocked_reason: 'still stuck' });
  });

  it('treats picking a soft link as dirty and sends the linked task id', () => {
    TASKS = [
      {
        id: 'task-1',
        name: 'Build login',
        blockedAgeSeconds: 3600,
        blockedReason: 'stuck',
        blockerType: 'vendor',
      },
      { id: 't9', name: 'Permit approval' },
    ];
    renderWith({ canEdit: true });
    fireEvent.change(screen.getByLabelText(/Related task/), { target: { value: 't9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(lastMutate().vars).toMatchObject({ blocking_task: 't9' });
  });

  it('omits the private reason from the payload when the viewer cannot read it', () => {
    setFlaggedTask({ blockedReason: undefined });
    renderWith({ canEdit: true });
    // Server gated the reason out — the editor still gets the triage controls.
    expect(screen.queryByLabelText('Reason')).toBeNull();
    expect(screen.getByText(/private to the assignee/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Type/), { target: { value: 'other' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(lastMutate().vars).not.toHaveProperty('blocked_reason');
    expect(lastMutate().vars).toMatchObject({ blocker_type: 'other' });
  });

  it('drops local drafts once the save succeeds', () => {
    setFlaggedTask();
    renderWith({ canEdit: true });
    const typeSelect = screen.getByLabelText<HTMLSelectElement>(/Type/);
    fireEvent.change(typeSelect, { target: { value: 'resource' } });
    expect(typeSelect.value).toBe('resource');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    act(() => lastMutate().options?.onSuccess?.());
    // Draft cleared → the control falls back to the persisted value and Save re-disables.
    expect(screen.getByLabelText<HTMLSelectElement>(/Type/).value).toBe('vendor');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });
});

describe('BlockerSection — flag form lifecycle', () => {
  it('closes the form and clears the draft once the flag succeeds', () => {
    setTask({ blockedAgeSeconds: null, blockedReason: '', blockerType: '' });
    renderWith({ canEdit: true });
    fireEvent.click(screen.getByRole('button', { name: /flag as blocked/i }));
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Waiting on permit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Flag blocked' }));

    act(() => lastMutate().options?.onSuccess?.());
    expect(screen.queryByLabelText('Reason')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /flag as blocked/i }));
    expect(screen.getByLabelText<HTMLTextAreaElement>('Reason').value).toBe('');
  });

  it('Cancel closes the form and discards the typed reason', () => {
    setTask({ blockedAgeSeconds: null, blockedReason: '', blockerType: '' });
    renderWith({ canEdit: true });
    fireEvent.click(screen.getByRole('button', { name: /flag as blocked/i }));
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'never mind' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByLabelText('Reason')).toBeNull();
    expect(mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /flag as blocked/i }));
    expect(screen.getByLabelText<HTMLTextAreaElement>('Reason').value).toBe('');
  });

  it('trims the reason and sends the chosen soft link when flagging', () => {
    TASKS = [
      { id: 'task-1', name: 'Build login', blockedAgeSeconds: null, blockedReason: '', blockerType: '' },
      { id: 't9', name: 'Permit approval' },
    ];
    renderWith({ canEdit: true });
    fireEvent.click(screen.getByRole('button', { name: /flag as blocked/i }));
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: '  permit pending  ' } });
    fireEvent.change(screen.getByLabelText(/Related task/), { target: { value: 't9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Flag blocked' }));
    expect(lastMutate().vars).toMatchObject({
      blocked_reason: 'permit pending',
      blocking_task: 't9',
    });
  });

  it('keeps Flag blocked disabled for whitespace-only reasons', () => {
    setTask({ blockedAgeSeconds: null, blockedReason: '', blockerType: '' });
    renderWith({ canEdit: true });
    fireEvent.click(screen.getByRole('button', { name: /flag as blocked/i }));
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: 'Flag blocked' })).toBeDisabled();
    expect(mutate).not.toHaveBeenCalled();
  });
});

describe('BlockerSection — offline save + sync announcements', () => {
  it('queues a type edit instead of a live PATCH and keeps the section revealed', () => {
    onlineState.value = false;
    setFlaggedTask();
    renderWith({ canEdit: true });
    fireEvent.change(screen.getByLabelText(/Type/), { target: { value: 'resource' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(mutate).not.toHaveBeenCalled();
    expect(useBlockerOutboxStore.getState().opsByTask['task-1']).toMatchObject({
      kind: 'flag',
      reason: 'stuck',
      blockerType: 'resource',
      blockingTask: null,
    });
    expect(screen.getByText(/Blocker changes queued/i)).toBeInTheDocument();
    expect(useDrawerSectionStore.getState().revealed[revealKey('task-1', 'blocker')]).toBe(true);
  });

  it('never overwrites a private reason it could not read when queueing offline', () => {
    onlineState.value = false;
    setFlaggedTask({ blockedReason: undefined });
    renderWith({ canEdit: true });
    fireEvent.change(screen.getByLabelText(/Type/), { target: { value: 'decision' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(useBlockerOutboxStore.getState().opsByTask['task-1']?.reason).toBeNull();
  });

  it('announces a sync when a queued write for this task later flushes', () => {
    setFlaggedTask();
    renderWith({ canEdit: true });
    expect(screen.queryByText('Blocker synced.')).toBeNull();
    act(() => {
      useBlockerOutboxStore.getState().markSynced('task-1');
    });
    expect(screen.getByText('Blocker synced.')).toBeInTheDocument();
  });

  it('stays silent when a different task syncs', () => {
    setFlaggedTask();
    renderWith({ canEdit: true });
    act(() => {
      useBlockerOutboxStore.getState().markSynced('some-other-task');
    });
    expect(screen.queryByText('Blocker synced.')).toBeNull();
  });

  it('keeps the real age (not "queued") for an offline edit to an already-flagged task', () => {
    seedPending({ kind: 'flag', wasFlagged: true });
    setFlaggedTask({ blockedAgeSeconds: 7200 });
    renderWith({ canEdit: true });
    expect(screen.queryByText('queued')).toBeNull();
    expect(screen.getByText('2h blocked')).toBeInTheDocument();
    expect(screen.getByLabelText(/Blocker flag queued/i)).toBeInTheDocument();
  });
});
