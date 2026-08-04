import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';

import { useReconcileStore } from '@/stores/reconcileStore';

import { ScheduleReconcileStrip } from './ScheduleReconcileStrip';
import { MON_FRI_MASK } from './reconcileCopy';

function reset() {
  act(() => {
    useReconcileStore.setState({
      projectId: 'p1',
      entries: {},
      reviewFilterActive: false,
      workingDaysMask: MON_FRI_MASK,
    });
  });
}

/** Drive a task through preview → diverged, the way a real commit would. */
function diverge(taskId: string, taskName: string, from: string, to: string) {
  act(() => {
    useReconcileStore.getState().registerPreview({ taskId, taskName, field: 'finish', value: from });
    useReconcileStore.getState().observe([{ taskId, field: 'finish', value: to }]);
  });
}

function renderStrip(projectFinish: string | null = '2026-10-16') {
  return render(
    <ScheduleReconcileStrip workingDaysMask={MON_FRI_MASK} projectFinish={projectFinish} />,
  );
}

describe('ScheduleReconcileStrip', () => {
  beforeEach(reset);

  it('mounts its live region even when idle, so the first announcement is heard', () => {
    // A live region that appears at the same moment its text does is not
    // reliably announced — the node has to already be in the a11y tree.
    renderStrip();
    const live = screen.getByTestId('reconcile-live');
    expect(live).toBeInTheDocument();
    expect(live).toHaveTextContent('');
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(live).toHaveAttribute('role', 'status');
    // Nothing else renders — no border, no height, no count.
    expect(screen.queryByTestId('reconcile-count')).not.toBeInTheDocument();
  });

  it('announces the recomputation politely and shows the count', () => {
    renderStrip();
    diverge('t1', 'Spec freeze', '2026-10-13', '2026-10-16');
    expect(screen.getByTestId('reconcile-live')).toHaveTextContent(
      'Schedule recomputed. 1 date changed. Project finish now October 16, 2026.',
    );
    expect(screen.getByTestId('reconcile-count')).toHaveTextContent('1 date changed');
  });

  it('counts each diverged field, not each task', () => {
    renderStrip();
    diverge('t1', 'Spec freeze', '2026-10-13', '2026-10-16');
    diverge('t2', 'Build', '2026-11-02', '2026-11-05');
    expect(screen.getByTestId('reconcile-count')).toHaveTextContent('2 dates changed');
  });

  it('the review toggle is a pressed-state filter, not a dialog', async () => {
    const user = userEvent.setup();
    renderStrip();
    diverge('t1', 'Spec freeze', '2026-10-13', '2026-10-16');

    const toggle = screen.getByTestId('reconcile-review-toggle');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(toggle).toHaveTextContent('Show 1 change');

    await user.click(toggle);
    expect(useReconcileStore.getState().reviewFilterActive).toBe(true);
    expect(screen.getByTestId('reconcile-review-toggle')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('the expanded list carries the full old → new sentence the cell cannot hold', async () => {
    const user = userEvent.setup();
    renderStrip();
    diverge('t1', 'Spec freeze', '2026-10-13', '2026-10-16');
    await user.click(screen.getByTestId('reconcile-review-toggle'));
    expect(screen.getByTestId('reconcile-change-list')).toHaveTextContent(
      'Finish moved Oct 13 → Oct 16',
    );
  });

  it('acknowledging the last change clears the filter — an empty outline reads as data loss', async () => {
    const user = userEvent.setup();
    renderStrip();
    diverge('t1', 'Spec freeze', '2026-10-13', '2026-10-16');
    await user.click(screen.getByTestId('reconcile-review-toggle'));
    expect(useReconcileStore.getState().reviewFilterActive).toBe(true);

    await user.click(screen.getByTestId('reconcile-ack-all'));
    expect(useReconcileStore.getState().reviewFilterActive).toBe(false);
    expect(screen.queryByTestId('reconcile-count')).not.toBeInTheDocument();
    expect(screen.getByTestId('reconcile-live')).toHaveTextContent('');
  });
});

describe('ScheduleReconcileStrip — refusals', () => {
  beforeEach(reset);

  function refuse(retry: (() => void) | null = null) {
    act(() => {
      useReconcileStore
        .getState()
        .registerPreview({ taskId: 't9', taskName: 'Locked task', field: 'start', value: '2026-10-13' });
      useReconcileStore.getState().reject('t9', 'start', 'You do not have permission.', retry);
    });
  }

  it('lists the refusal with the server reason — never a silent revert', () => {
    renderStrip();
    refuse();
    expect(screen.getByTestId('reconcile-rejected-count')).toHaveTextContent('1 change refused');
    const list = screen.getByTestId('reconcile-rejected-list');
    expect(list).toHaveTextContent('Locked task');
    expect(list).toHaveTextContent('You do not have permission.');
  });

  it('Retry re-issues the original mutation and clears the refusal', async () => {
    const user = userEvent.setup();
    const retry = vi.fn();
    renderStrip();
    refuse(retry);

    await user.click(screen.getByRole('button', { name: /Retry the refused change on Locked task/ }));
    expect(retry).toHaveBeenCalledTimes(1);
    // The re-issued mutation's onMutate opens a fresh preview, so the stale
    // rejection must not outlive the write it described.
    expect(screen.queryByTestId('reconcile-rejected-count')).not.toBeInTheDocument();
  });

  it('offers no Retry when the write path supplied none', () => {
    renderStrip();
    refuse(null);
    expect(screen.queryByRole('button', { name: /^Retry/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Dismiss/ })).toBeInTheDocument();
  });

  it('Acknowledge all leaves refusals alone — they still need a human', async () => {
    const user = userEvent.setup();
    renderStrip();
    diverge('t1', 'Spec freeze', '2026-10-13', '2026-10-16');
    refuse();

    await user.click(screen.getByTestId('reconcile-ack-all'));
    expect(screen.queryByTestId('reconcile-count')).not.toBeInTheDocument();
    expect(screen.getByTestId('reconcile-rejected-count')).toBeInTheDocument();
  });
});
