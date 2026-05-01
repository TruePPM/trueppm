import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { SprintBacklogTable } from './SprintBacklogTable';
import type { SprintBacklogTask } from '@/hooks/useSprintBacklog';

function task(overrides: Partial<SprintBacklogTask>): SprintBacklogTask {
  return {
    id: overrides.id ?? `t-${Math.random()}`,
    short_id: overrides.short_id ?? 'A1',
    name: overrides.name ?? 'Task',
    wbs_path: overrides.wbs_path ?? null,
    status: overrides.status ?? 'BACKLOG',
    story_points: overrides.story_points ?? null,
    is_critical: overrides.is_critical ?? false,
    assignments: overrides.assignments ?? [],
  };
}

beforeEach(() => {
  sessionStorage.clear();
});

describe('SprintBacklogTable', () => {
  it('renders the section heading and total task / point counts', () => {
    renderWithRouter(
      <SprintBacklogTable
        projectId="proj-1"
        sprintId="sp-1"
        tasks={[
          task({ id: '1', status: 'IN_PROGRESS', story_points: 5 }),
          task({ id: '2', status: 'COMPLETE', story_points: 8 }),
        ]}
      />,
    );
    expect(screen.getByRole('heading', { level: 2, name: /Sprint Backlog/i })).toBeInTheDocument();
    const subheading = screen.getByText(/grouped by board status/i);
    expect(subheading).toHaveTextContent(/2 tasks/);
    expect(subheading).toHaveTextContent(/13.*pts committed/i);
  });

  it('groups rows by board status and shows per-group point subtotals', () => {
    renderWithRouter(
      <SprintBacklogTable
        projectId="proj-1"
        sprintId="sp-1"
        tasks={[
          task({ id: '1', status: 'IN_PROGRESS', story_points: 3, name: 'Wire telemetry' }),
          task({ id: '2', status: 'IN_PROGRESS', story_points: 5, name: 'Calibrate sensors' }),
          task({ id: '3', status: 'BACKLOG', story_points: 2, name: 'Write FAT plan' }),
        ]}
      />,
    );
    // Group buttons (the toggles) carry "In Progress 2 8 pts" text
    const inProgress = screen.getByRole('button', { name: /In Progress/i });
    expect(within(inProgress).getByText('2')).toBeInTheDocument();
    expect(within(inProgress).getByText('8 pts')).toBeInTheDocument();
    const backlog = screen.getByRole('button', { name: /Backlog/i });
    expect(within(backlog).getByText('1')).toBeInTheDocument();
    expect(within(backlog).getByText('2 pts')).toBeInTheDocument();
  });

  it('renders the CP flag only for critical-path tasks', () => {
    renderWithRouter(
      <SprintBacklogTable
        projectId="proj-1"
        sprintId="sp-1"
        tasks={[
          task({ id: '1', name: 'Critical', is_critical: true, status: 'IN_PROGRESS' }),
          task({ id: '2', name: 'Slack', is_critical: false, status: 'IN_PROGRESS' }),
        ]}
      />,
    );
    const cpFlags = screen.getAllByLabelText(/Critical path task/i);
    expect(cpFlags).toHaveLength(1);
  });

  it('opens-in-board link points at the correct sprint filter', () => {
    renderWithRouter(
      <SprintBacklogTable projectId="proj-1" sprintId="sp-active" tasks={[]} />,
    );
    const link = screen.getByRole('link', { name: /Open in board/i });
    expect(link).toHaveAttribute('href', '/projects/proj-1/board?sprint=sp-active');
  });

  it('shows the empty state when no tasks are committed', () => {
    renderWithRouter(
      <SprintBacklogTable projectId="proj-1" sprintId="sp-1" tasks={[]} />,
    );
    expect(
      screen.getByText(/No tasks committed to this sprint yet/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Plan the next sprint or add tasks from the board/i),
    ).toBeInTheDocument();
  });

  it('collapsing a group hides its rows and persists in sessionStorage', async () => {
    renderWithRouter(
      <SprintBacklogTable
        projectId="proj-1"
        sprintId="sp-1"
        tasks={[task({ id: '1', name: 'Wire telemetry', status: 'IN_PROGRESS' })]}
      />,
    );
    expect(screen.getByText('Wire telemetry')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: /In Progress/i }));
    expect(screen.queryByText('Wire telemetry')).not.toBeInTheDocument();
    expect(
      sessionStorage.getItem('trueppm.sprintBacklog.collapsed.sp-1.IN_PROGRESS'),
    ).toBe('1');
  });

  it('renders the ⌘K keyboard hint for adding a task', () => {
    renderWithRouter(
      <SprintBacklogTable projectId="proj-1" sprintId="sp-1" tasks={[]} />,
    );
    expect(screen.getByLabelText(/Press cmd-K to add a task/i)).toBeInTheDocument();
  });

  it('shows initials avatars (truncated to 3 + overflow chip)', () => {
    renderWithRouter(
      <SprintBacklogTable
        projectId="proj-1"
        sprintId="sp-1"
        tasks={[
          task({
            id: '1',
            status: 'IN_PROGRESS',
            assignments: [
              { resource_id: 'r1', resource_name: 'Aisha Khan', units: 1 },
              { resource_id: 'r2', resource_name: 'Ben Lee', units: 1 },
              { resource_id: 'r3', resource_name: 'Cleo Ng', units: 1 },
              { resource_id: 'r4', resource_name: 'Dan Ortiz', units: 1 },
            ],
          }),
        ]}
      />,
    );
    expect(screen.getByText('AK')).toBeInTheDocument();
    expect(screen.getByText('BL')).toBeInTheDocument();
    expect(screen.getByText('CN')).toBeInTheDocument();
    expect(screen.getByLabelText(/1 more owners/i)).toBeInTheDocument();
  });
});
