/**
 * UnscheduledGutter unit tests — two-section tray (#318, rule 132/133).
 *
 * Covers:
 *  - partition of the task list into a To Do section (NOT_STARTED) and a
 *    Backlog section (status === 'BACKLOG')
 *  - summed header count
 *  - per-section role="status" empty rows (never hide one while the other fills)
 *  - backlog chips carry the dashed left edge + readiness label variant
 */
import { screen, within } from '@testing-library/react';
import { renderWithProviders as render } from '@/test/utils';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRef, type ReactElement } from 'react';
import type { ApiSprint, Task } from '@/types';
import { UnscheduledGutter } from './UnscheduledGutter';

vi.mock('@/api/client', () => ({
  apiClient: { patch: vi.fn().mockResolvedValue({ data: {} }) },
}));

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    wbs: '1',
    name: 'Task',
    start: '',
    finish: '',
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

function makeSprint(overrides: Partial<ApiSprint> & { id: string }): ApiSprint {
  return {
    name: 'Sprint',
    state: 'PLANNED',
    start_date: '2026-07-17',
    finish_date: '2026-07-30',
    ...overrides,
  } as unknown as ApiSprint;
}

function renderGutter(tasks: Task[], sprints?: ApiSprint[]): ReturnType<typeof render> {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const canvasScrollRef = createRef<HTMLDivElement>();
  const ui: ReactElement = (
    <QueryClientProvider client={qc}>
      <UnscheduledGutter
        tasks={tasks}
        projectId="proj1"
        scaleData={null}
        canvasScrollRef={canvasScrollRef}
        taskListWidth={200}
        sprints={sprints}
      />
    </QueryClientProvider>
  );
  return render(ui);
}

beforeEach(() => {
  localStorage.removeItem('trueppm.gantt.unscheduledGutter.collapsed');
});

describe('UnscheduledGutter — two-section tray', () => {
  it('partitions tasks into To Do and Backlog sections with summed header count', () => {
    renderGutter([
      makeTask({ id: 'a', name: 'Wire login', status: 'NOT_STARTED' }),
      makeTask({ id: 'b', name: 'Spike auth', status: 'BACKLOG' }),
      makeTask({ id: 'c', name: 'Idea three', status: 'BACKLOG' }),
    ]);

    // Header count is the sum across both sections.
    expect(screen.getByText('(3)')).toBeInTheDocument();

    const todoSection = screen.getByRole('group', { name: /To do, unscheduled, 1 task/i });
    expect(within(todoSection).getByText('Wire login')).toBeInTheDocument();
    expect(within(todoSection).queryByText('Spike auth')).not.toBeInTheDocument();

    const backlogSection = screen.getByRole('group', { name: /Backlog, 2 items/i });
    expect(within(backlogSection).getByText('Spike auth')).toBeInTheDocument();
    expect(within(backlogSection).getByText('Idea three')).toBeInTheDocument();
  });

  it('renders the To Do and Backlog sub-headers with their own counts', () => {
    renderGutter([
      makeTask({ id: 'a', status: 'NOT_STARTED' }),
      makeTask({ id: 'b', status: 'BACKLOG' }),
    ]);
    expect(screen.getByText('To Do · Unscheduled (1)')).toBeInTheDocument();
    expect(screen.getByText('Backlog (1)')).toBeInTheDocument();
  });

  it('keeps the Backlog section with a status empty row while To Do has items', () => {
    renderGutter([makeTask({ id: 'a', status: 'NOT_STARTED' })]);

    const backlogSection = screen.getByRole('group', { name: /Backlog, 0 items/i });
    expect(within(backlogSection).getByRole('status')).toHaveTextContent('No backlog items');
  });

  it('keeps the To Do section with a status empty row while Backlog has items', () => {
    renderGutter([makeTask({ id: 'b', status: 'BACKLOG' })]);

    const todoSection = screen.getByRole('group', { name: /To do, unscheduled, 0 tasks/i });
    expect(within(todoSection).getByRole('status')).toHaveTextContent(
      'No unscheduled To Do tasks',
    );
  });

  it('gives backlog chips a dashed left edge and a readiness label (rule 133)', () => {
    const { container } = renderGutter([
      makeTask({ id: 'b', name: 'Spike auth', status: 'BACKLOG', readiness: 'idea' }),
    ]);

    // The dashed left edge is the at-a-glance promote cue.
    const dashedRow = container.querySelector('.border-dashed');
    expect(dashedRow).not.toBeNull();
    expect(dashedRow?.className).toContain('border-l-2');

    // The readiness label is the non-color signal.
    expect(within(dashedRow as HTMLElement).getByText('idea')).toBeInTheDocument();
  });

  it('does not render a dashed edge on To Do chips', () => {
    const { container } = renderGutter([
      makeTask({ id: 'a', name: 'Wire login', status: 'NOT_STARTED' }),
    ]);
    expect(container.querySelector('.border-dashed')).toBeNull();
  });
});

describe('UnscheduledGutter — sprint-assigned backlog groups (#1790)', () => {
  it('groups sprint-assigned backlog under its target sprint with an honest header', () => {
    renderGutter(
      [makeTask({ id: 'sb', name: 'Contact dedupe', status: 'BACKLOG', sprintId: 's3', storyPoints: 5 })],
      [makeSprint({ id: 's3', name: 'Build Sprint 3', state: 'PLANNED' })],
    );

    const group = screen.getByRole('group', {
      name: /Targeted for Build Sprint 3, planned, read-only, 1 task/i,
    });
    expect(within(group).getByText('Contact dedupe')).toBeInTheDocument();
    // Honest, non-committal sub-note — never implies a committed date.
    expect(within(group).getByText('pending team plan — not scheduled')).toBeInTheDocument();
    // Story points surface the sprint-planning vocabulary.
    expect(within(group).getByText('5 pts')).toBeInTheDocument();
  });

  it('renders sprint-assigned backlog rows READ-ONLY — no actions menu, muted "planned" label', () => {
    renderGutter(
      [makeTask({ id: 'sb', name: 'Contact dedupe', status: 'BACKLOG', sprintId: 's3' })],
      [makeSprint({ id: 's3', name: 'Build Sprint 3' })],
    );

    const group = screen.getByRole('group', { name: /Targeted for Build Sprint 3/i });
    // The ··· "Actions for …" scheduling menu must not exist — dating a
    // sprint-committed item from the Schedule would violate sprint sovereignty.
    expect(within(group).queryByRole('button', { name: /Actions for/i })).toBeNull();
    expect(within(group).getByText('planned')).toBeInTheDocument();
  });

  it('keeps sprint-assigned backlog OUT of the no-sprint Backlog section', () => {
    renderGutter(
      [
        makeTask({ id: 'nb', name: 'No-sprint idea', status: 'BACKLOG', sprintId: null }),
        makeTask({ id: 'sb', name: 'Sprint idea', status: 'BACKLOG', sprintId: 's3' }),
      ],
      [makeSprint({ id: 's3', name: 'Build Sprint 3' })],
    );

    const backlogSection = screen.getByRole('group', { name: /Backlog, 1 item/i });
    expect(within(backlogSection).getByText('No-sprint idea')).toBeInTheDocument();
    expect(within(backlogSection).queryByText('Sprint idea')).not.toBeInTheDocument();
    // Header count is the sum across all sections (1 no-sprint + 1 sprint-assigned).
    expect(screen.getByText('(2)')).toBeInTheDocument();
  });

  it('labels an ACTIVE target sprint honestly (not "pending team plan")', () => {
    renderGutter(
      [makeTask({ id: 'sb', name: 'Stretch item', status: 'BACKLOG', sprintId: 's2' })],
      [makeSprint({ id: 's2', name: 'Build Sprint 2', state: 'ACTIVE' })],
    );
    const group = screen.getByRole('group', { name: /Targeted for Build Sprint 2, active, read-only/i });
    expect(within(group).getByText('not yet started — not scheduled')).toBeInTheDocument();
  });
});
