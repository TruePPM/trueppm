import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders as render } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { CloseSprintDialog } from './CloseSprintDialog';
import { makeSprint } from './sprintTestFixtures';
import type { SprintBacklogTask } from '@/hooks/useSprintBacklog';

function task(overrides: Partial<SprintBacklogTask> = {}): SprintBacklogTask {
  return {
    id: overrides.id ?? 't1',
    short_id: overrides.short_id ?? 'T-1',
    name: overrides.name ?? 'Task',
    wbs_path: overrides.wbs_path ?? null,
    status: overrides.status ?? 'IN_PROGRESS',
    story_points: overrides.story_points ?? null,
    is_critical: overrides.is_critical ?? false,
    assignments: overrides.assignments ?? [],
  };
}

describe('CloseSprintDialog', () => {
  it('renders the sprint name in the heading', () => {
    render(
      <CloseSprintDialog
        sprint={makeSprint({ state: 'ACTIVE', name: 'Sprint A' })}
        nextPlannedSprintId={null}
        nextPlannedSprintName={null}
        backlogTasks={[]}
        isClosing={false}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );
    expect(screen.getByRole('dialog', { name: /Close Sprint A/ })).toBeInTheDocument();
  });

  it('renders remaining task + point counts (excluding completed)', () => {
    render(
      <CloseSprintDialog
        sprint={makeSprint({ state: 'ACTIVE' })}
        nextPlannedSprintId={null}
        nextPlannedSprintName={null}
        backlogTasks={[
          task({ id: 't1', status: 'COMPLETE', story_points: 3 }),
          task({ id: 't2', status: 'IN_PROGRESS', story_points: 5 }),
          task({ id: 't3', status: 'REVIEW', story_points: 2 }),
        ]}
        isClosing={false}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );
    // 2 incomplete tasks (t2, t3) totaling 7 points.
    expect(screen.getByText(/2/)).toBeInTheDocument();
    expect(screen.getByText(/7/)).toBeInTheDocument();
  });

  it('preselects "next planned" when one is provided', () => {
    render(
      <CloseSprintDialog
        sprint={makeSprint({ state: 'ACTIVE' })}
        nextPlannedSprintId="sp-next"
        nextPlannedSprintName="Sprint B"
        backlogTasks={[]}
        isClosing={false}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );
    const nextRadio = screen.getByRole('radio', { name: /Next planned sprint/ });
    expect(nextRadio).toBeChecked();
  });

  it('preselects backlog when there is no next planned sprint', () => {
    render(
      <CloseSprintDialog
        sprint={makeSprint({ state: 'ACTIVE' })}
        nextPlannedSprintId={null}
        nextPlannedSprintName={null}
        backlogTasks={[]}
        isClosing={false}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );
    expect(screen.getByRole('radio', { name: /Project backlog/ })).toBeChecked();
  });

  it('confirm with default "next" selection passes the sprint id to onConfirm', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      <CloseSprintDialog
        sprint={makeSprint({ state: 'ACTIVE' })}
        nextPlannedSprintId="sp-next-uuid"
        nextPlannedSprintName="Sprint B"
        backlogTasks={[]}
        isClosing={false}
        onCancel={() => {}}
        onConfirm={onConfirm}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Close sprint' }));
    // ADR-0102: 2nd arg (pendingDisposition) is undefined when nothing is pending.
    expect(onConfirm).toHaveBeenCalledWith('sp-next-uuid', undefined);
  });

  it('confirm with "backlog" selection passes "backlog"', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      <CloseSprintDialog
        sprint={makeSprint({ state: 'ACTIVE' })}
        nextPlannedSprintId={null}
        nextPlannedSprintName={null}
        backlogTasks={[]}
        isClosing={false}
        onCancel={() => {}}
        onConfirm={onConfirm}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Close sprint' }));
    expect(onConfirm).toHaveBeenCalledWith('backlog', undefined);
  });

  it('selecting "Leave on this sprint" passes "none"', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      <CloseSprintDialog
        sprint={makeSprint({ state: 'ACTIVE' })}
        nextPlannedSprintId={null}
        nextPlannedSprintName={null}
        backlogTasks={[]}
        isClosing={false}
        onCancel={() => {}}
        onConfirm={onConfirm}
      />,
    );
    await user.click(screen.getByRole('radio', { name: /Leave on this sprint/ }));
    await user.click(screen.getByRole('button', { name: 'Close sprint' }));
    expect(onConfirm).toHaveBeenCalledWith('none', undefined);
  });

  it('shows the pending-scope advisory and passes the disposition when pending > 0 (ADR-0102 §7)', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      <CloseSprintDialog
        sprint={makeSprint({ state: 'ACTIVE', pending_count: 2 })}
        nextPlannedSprintId={null}
        nextPlannedSprintName={null}
        backlogTasks={[]}
        isClosing={false}
        onCancel={() => {}}
        onConfirm={onConfirm}
      />,
    );
    // Advisory surfaces but never blocks the close. (The count is in a
    // tppm-mono span, so match on the surrounding label text.)
    expect(screen.getByText(/items? pending acceptance/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Carry them to the next sprint/ })).toBeChecked();
    // Default disposition is carry-over.
    await user.click(screen.getByRole('button', { name: 'Close sprint' }));
    expect(onConfirm).toHaveBeenLastCalledWith('backlog', 'carry');
  });

  it('passes reject when the pending advisory reject option is chosen', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      <CloseSprintDialog
        sprint={makeSprint({ state: 'ACTIVE', pending_count: 1 })}
        nextPlannedSprintId={null}
        nextPlannedSprintName={null}
        backlogTasks={[]}
        isClosing={false}
        onCancel={() => {}}
        onConfirm={onConfirm}
      />,
    );
    await user.click(screen.getByRole('radio', { name: /Reject them/ }));
    await user.click(screen.getByRole('button', { name: 'Close sprint' }));
    expect(onConfirm).toHaveBeenLastCalledWith('backlog', 'reject');
  });

  it('Cancel calls onCancel and is disabled while closing', async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(
      <CloseSprintDialog
        sprint={makeSprint({ state: 'ACTIVE' })}
        nextPlannedSprintId={null}
        nextPlannedSprintName={null}
        backlogTasks={[]}
        isClosing={false}
        onCancel={onCancel}
        onConfirm={() => {}}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('confirm button shows loading state while closing', () => {
    render(
      <CloseSprintDialog
        sprint={makeSprint({ state: 'ACTIVE' })}
        nextPlannedSprintId={null}
        nextPlannedSprintName={null}
        backlogTasks={[]}
        isClosing
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: 'Closing…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });
});
