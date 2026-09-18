import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import {
  ResourceOverallocationDrawer,
  type OverallocationTarget,
} from './ResourceOverallocationDrawer';

// Control the responsive shell. The #2148 fix renders exactly ONE shell per
// breakpoint (rule 211) instead of CSS-hiding a second copy, so this mock lets us
// assert there is never a double-mounted dialog.
const mockBreakpoint = vi.fn<() => 'sm' | 'md' | 'lg'>();
vi.mock('@/hooks/useBreakpoint', () => ({
  useBreakpoint: () => mockBreakpoint(),
}));

interface ResolvedTaskPayload {
  id: string;
  name: string;
  status: string;
}

const { getMock } = vi.hoisted(() => ({
  getMock: vi.fn<(url: string, config?: unknown) => Promise<{ data: { results: ResolvedTaskPayload[] } }>>(),
}));

vi.mock('@/api/client', () => ({
  apiClient: { get: getMock },
}));

function resolveWith(results: ResolvedTaskPayload[]) {
  getMock.mockResolvedValue({ data: { results } });
}

function targetWithTasks(taskIds: string[]): OverallocationTarget {
  return {
    resourceId: 'r1',
    resourceName: 'Anna Khoury',
    iso: '2026-04-20',
    entry: { hours: 10, load_pct: 125, tasks: taskIds },
    hoursPerDay: 8,
    maxUnits: 1,
  } as unknown as OverallocationTarget;
}

const target = {
  resourceId: 'r1',
  resourceName: 'Anna Khoury',
  iso: '2026-04-20',
  entry: { hours: 10, load_pct: 125, tasks: [] },
  hoursPerDay: 8,
  maxUnits: 1,
} as unknown as OverallocationTarget;

function renderDrawer(t: OverallocationTarget | null, isOpen = true, onClose = vi.fn()) {
  return renderWithProviders(
    <ResourceOverallocationDrawer projectId="p1" target={t} isOpen={isOpen} onClose={onClose} />,
  );
}

describe('ResourceOverallocationDrawer responsive shell (#2148)', () => {
  beforeEach(() => {
    mockBreakpoint.mockReset();
    getMock.mockReset();
    resolveWith([]);
  });

  it('renders exactly one dialog on desktop — the right-side panel, no double-mount', () => {
    mockBreakpoint.mockReturnValue('lg');
    renderDrawer(target);
    const dialogs = screen.getAllByRole('dialog');
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0].className).toContain('w-[480px]');
    expect(dialogs[0].className).toContain('right-0');
  });

  it('renders exactly one dialog on mobile — the bottom sheet', () => {
    mockBreakpoint.mockReturnValue('sm');
    renderDrawer(target);
    const dialogs = screen.getAllByRole('dialog');
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0].className).toContain('rounded-t-card');
    expect(dialogs[0].className).toContain('bottom-0');
  });

  it('binds the close button to the visible shell and fires onClose', async () => {
    mockBreakpoint.mockReturnValue('lg');
    const onClose = vi.fn();
    renderDrawer(target, true, onClose);
    await userEvent.click(
      screen.getByRole('button', { name: 'Close overallocation drawer' }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('marks the shell aria-hidden when closed', () => {
    mockBreakpoint.mockReturnValue('lg');
    renderDrawer(null, false);
    expect(screen.getByRole('dialog', { hidden: true })).toHaveAttribute(
      'aria-hidden',
      'true',
    );
  });
});

describe('ResourceOverallocationDrawer contributing tasks (#3843)', () => {
  beforeEach(() => {
    mockBreakpoint.mockReturnValue('lg');
    getMock.mockReset();
  });

  it('renders resolved task names, not raw UUIDs, given a populated tasks list', async () => {
    const taskId = '11111111-1111-1111-1111-111111111111';
    resolveWith([{ id: taskId, name: 'Wire the avionics loom', status: 'IN_PROGRESS' }]);
    renderDrawer(targetWithTasks([taskId]));

    expect(await screen.findByText('Wire the avionics loom')).toBeInTheDocument();
    expect(screen.getByText('In progress')).toBeInTheDocument();
    // A UUID could not satisfy this — the raw id string must not be on screen.
    expect(screen.queryByText(taskId)).not.toBeInTheDocument();
  });

  it('requests the exact contributing task ids scoped to the project', async () => {
    const idA = '11111111-1111-1111-1111-111111111111';
    const idB = '22222222-2222-2222-2222-222222222222';
    resolveWith([
      { id: idA, name: 'Task A', status: 'NOT_STARTED' },
      { id: idB, name: 'Task B', status: 'NOT_STARTED' },
    ]);
    renderDrawer(targetWithTasks([idA, idB]));
    await screen.findByText('Task A');
    expect(getMock).toHaveBeenCalledWith('/tasks/', {
      params: { project: 'p1', id__in: `${idA},${idB}` },
    });
  });

  it('shows loading placeholders, not the raw ids, while the fetch is in flight', () => {
    const taskId = '11111111-1111-1111-1111-111111111111';
    getMock.mockReturnValue(new Promise<{ data: { results: ResolvedTaskPayload[] } }>(() => {}));
    const { container } = renderDrawer(targetWithTasks([taskId]));
    expect(container.getElementsByClassName('motion-safe:animate-pulse')).toHaveLength(1);
    expect(screen.queryByText(taskId)).not.toBeInTheDocument();
  });

  it('degrades to the UUID with an explanatory note when a task id fails to resolve', async () => {
    const knownId = '11111111-1111-1111-1111-111111111111';
    const missingId = '22222222-2222-2222-2222-222222222222';
    resolveWith([{ id: knownId, name: 'Known task', status: 'NOT_STARTED' }]);
    renderDrawer(targetWithTasks([knownId, missingId]));

    expect(await screen.findByText('Known task')).toBeInTheDocument();
    expect(screen.getByText(missingId)).toBeInTheDocument();
    expect(screen.getByText(/this task may have been deleted/i)).toBeInTheDocument();
  });

  it('degrades every task to its raw id, with a retry affordance, on a fetch error', async () => {
    const idA = '11111111-1111-1111-1111-111111111111';
    getMock.mockRejectedValue(new Error('network down'));
    renderDrawer(targetWithTasks([idA]));

    expect(await screen.findByText(idA)).toBeInTheDocument();
    expect(screen.getByText(/could not load task names/i)).toBeInTheDocument();
    const retry = await screen.findByRole('button', { name: 'Retry' });

    resolveWith([{ id: idA, name: 'Recovered task', status: 'NOT_STARTED' }]);
    await userEvent.click(retry);
    expect(await screen.findByText('Recovered task')).toBeInTheDocument();
  });

  it('does not render a contributing-tasks section, and does not fetch, when there are no tasks', () => {
    renderDrawer(target);
    expect(screen.queryByText(/Contributing tasks/)).not.toBeInTheDocument();
    expect(getMock).not.toHaveBeenCalled();
  });

  it('no longer ships the stale "tasks API is connected" deferral copy', async () => {
    const taskId = '11111111-1111-1111-1111-111111111111';
    resolveWith([{ id: taskId, name: 'Wire the avionics loom', status: 'IN_PROGRESS' }]);
    renderDrawer(targetWithTasks([taskId]));
    await screen.findByText('Wire the avionics loom');
    expect(
      screen.queryByText(/Task names will appear once the tasks API is connected/i),
    ).not.toBeInTheDocument();
  });
});
