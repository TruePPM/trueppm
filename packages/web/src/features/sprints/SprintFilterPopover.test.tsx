import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders as render } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { useRef } from 'react';
import {
  SprintFilterPopover,
  applySprintFilter,
  type SprintFilterValue,
} from './SprintFilterPopover';
import type { SprintBacklogTask } from '@/hooks/useSprintBacklog';

function task(overrides: Partial<SprintBacklogTask> = {}): SprintBacklogTask {
  return {
    id: overrides.id ?? 't1',
    short_id: overrides.short_id ?? 'T-1',
    name: overrides.name ?? 'Task',
    wbs_path: overrides.wbs_path ?? null,
    status: overrides.status ?? 'NOT_STARTED',
    story_points: overrides.story_points ?? null,
    is_critical: overrides.is_critical ?? false,
    assignments: overrides.assignments ?? [],
  };
}

function Harness({
  open,
  value,
  onChange,
  tasks,
  onClose,
}: {
  open: boolean;
  value: SprintFilterValue;
  onChange: (next: SprintFilterValue) => void;
  tasks: SprintBacklogTask[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={ref} type="button">
        anchor
      </button>
      <SprintFilterPopover
        open={open}
        anchorRef={ref}
        value={value}
        onChange={onChange}
        tasks={tasks}
        onClose={onClose}
      />
    </>
  );
}

describe('SprintFilterPopover', () => {
  it('does not render when open=false', () => {
    const onChange = vi.fn();
    render(
      <Harness
        open={false}
        value={{ assignee: 'anyone', statuses: new Set() }}
        onChange={onChange}
        tasks={[]}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByRole('dialog', { name: /Filter sprint backlog/ })).not.toBeInTheDocument();
  });

  it('renders Me / Anyone radios and the per-resource list', () => {
    render(
      <Harness
        open
        value={{ assignee: 'anyone', statuses: new Set() }}
        onChange={() => {}}
        tasks={[
          task({ id: 't1', assignments: [{ resource_id: 'r1', resource_name: 'Alice', units: 1 }] }),
          task({ id: 't2', assignments: [{ resource_id: 'r2', resource_name: 'Bob', units: 1 }] }),
        ]}
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole('radio', { name: 'Me' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Anyone' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Alice' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Bob' })).toBeInTheDocument();
  });

  it('selecting Me calls onChange with assignee="me"', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <Harness
        open
        value={{ assignee: 'anyone', statuses: new Set() }}
        onChange={onChange}
        tasks={[]}
        onClose={() => {}}
      />,
    );
    await user.click(screen.getByRole('radio', { name: 'Me' }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ assignee: 'me' }),
    );
  });

  it('toggling a status chip adds it to the statuses set', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <Harness
        open
        value={{ assignee: 'anyone', statuses: new Set() }}
        onChange={onChange}
        tasks={[]}
        onClose={() => {}}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'In Progress' }));
    const lastCall = onChange.mock.calls.at(-1)?.[0] as SprintFilterValue;
    expect(lastCall.statuses.has('IN_PROGRESS')).toBe(true);
  });

  it('Reset clears statuses and assignee', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <Harness
        open
        value={{ assignee: 'me', statuses: new Set(['REVIEW']) }}
        onChange={onChange}
        tasks={[]}
        onClose={() => {}}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    const lastCall = onChange.mock.calls.at(-1)?.[0] as SprintFilterValue;
    expect(lastCall.assignee).toBe('anyone');
    expect(lastCall.statuses.size).toBe(0);
  });

  it('Apply button calls onClose', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <Harness
        open
        value={{ assignee: 'anyone', statuses: new Set() }}
        onChange={() => {}}
        tasks={[]}
        onClose={onClose}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Close filter popover' }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('applySprintFilter', () => {
  const tasks: SprintBacklogTask[] = [
    task({ id: 't1', name: 'Alice in progress', status: 'IN_PROGRESS', assignments: [{ resource_id: 'r1', resource_name: 'Alice', units: 1 }] }),
    task({ id: 't2', name: 'Bob review', status: 'REVIEW', assignments: [{ resource_id: 'r2', resource_name: 'Bob', units: 1 }] }),
    task({ id: 't3', name: 'Alice review', status: 'REVIEW', assignments: [{ resource_id: 'r1', resource_name: 'Alice', units: 1 }] }),
    task({ id: 't4', name: 'Unassigned', status: 'IN_PROGRESS', assignments: [] }),
  ];

  it('returns all tasks when filter is empty', () => {
    expect(
      applySprintFilter(tasks, { assignee: 'anyone', statuses: new Set() }, null),
    ).toHaveLength(4);
  });

  it('filters by status when statuses are set', () => {
    const out = applySprintFilter(
      tasks,
      { assignee: 'anyone', statuses: new Set(['REVIEW']) },
      null,
    );
    expect(out.map((t) => t.id).sort()).toEqual(['t2', 't3']);
  });

  it('filters by "me" using the supplied resource id', () => {
    const out = applySprintFilter(
      tasks,
      { assignee: 'me', statuses: new Set() },
      'r1',
    );
    expect(out.map((t) => t.id).sort()).toEqual(['t1', 't3']);
  });

  it('returns nothing when assignee="me" but myResourceId is null', () => {
    expect(
      applySprintFilter(tasks, { assignee: 'me', statuses: new Set() }, null),
    ).toEqual([]);
  });

  it('combines assignee + status filters', () => {
    const out = applySprintFilter(
      tasks,
      { assignee: 'me', statuses: new Set(['REVIEW']) },
      'r1',
    );
    expect(out.map((t) => t.id)).toEqual(['t3']);
  });

  it('filters by a specific resource id', () => {
    const out = applySprintFilter(
      tasks,
      { assignee: 'r2', statuses: new Set() },
      null,
    );
    expect(out.map((t) => t.id)).toEqual(['t2']);
  });
});
