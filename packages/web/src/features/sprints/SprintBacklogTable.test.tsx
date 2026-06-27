import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
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

  it('shows + Add task button in header when onAddTask is provided', () => {
    const onAddTask = vi.fn();
    renderWithRouter(
      <SprintBacklogTable projectId="proj-1" sprintId="sp-1" tasks={[task({ id: '1', status: 'NOT_STARTED' })]} onAddTask={onAddTask} />,
    );
    expect(screen.getByRole('button', { name: /\+ Add task/i })).toBeInTheDocument();
  });

  it('calls onAddTask when header button is clicked', async () => {
    const onAddTask = vi.fn();
    renderWithRouter(
      <SprintBacklogTable projectId="proj-1" sprintId="sp-1" tasks={[task({ id: '1', status: 'NOT_STARTED' })]} onAddTask={onAddTask} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /\+ Add task/i }));
    expect(onAddTask).toHaveBeenCalledOnce();
  });

  it('shows + Add task button in empty state when onAddTask is provided', () => {
    renderWithRouter(
      <SprintBacklogTable projectId="proj-1" sprintId="sp-1" tasks={[]} onAddTask={vi.fn()} />,
    );
    // Empty state renders an Add task button (no header button since no tasks)
    const buttons = screen.getAllByRole('button', { name: /\+ Add task/i });
    expect(buttons.length).toBeGreaterThan(0);
  });

  it('does not show + Add task button when onAddTask is omitted', () => {
    renderWithRouter(
      <SprintBacklogTable projectId="proj-1" sprintId="sp-1" tasks={[]} />,
    );
    expect(screen.queryByRole('button', { name: /\+ Add task/i })).not.toBeInTheDocument();
  });

  it('renders task names as buttons and calls onOpenTask with the task id on click', async () => {
    const onOpenTask = vi.fn();
    renderWithRouter(
      <SprintBacklogTable
        projectId="proj-1"
        sprintId="sp-1"
        tasks={[task({ id: 'task-42', name: 'Calibrate sensors', status: 'BACKLOG' })]}
        onOpenTask={onOpenTask}
      />,
    );
    const openBtn = screen.getByRole('button', { name: /Open Calibrate sensors/i });
    await userEvent.click(openBtn);
    expect(onOpenTask).toHaveBeenCalledExactlyOnceWith('task-42');
  });

  it('opens a task via keyboard activation (Enter) on the name button', async () => {
    const onOpenTask = vi.fn();
    renderWithRouter(
      <SprintBacklogTable
        projectId="proj-1"
        sprintId="sp-1"
        tasks={[task({ id: 'task-7', name: 'Wire telemetry channel', status: 'IN_PROGRESS' })]}
        onOpenTask={onOpenTask}
      />,
    );
    const openBtn = screen.getByRole('button', { name: /Open Wire telemetry channel/i });
    openBtn.focus();
    await userEvent.keyboard('{Enter}');
    expect(onOpenTask).toHaveBeenCalledExactlyOnceWith('task-7');
  });

  it('renders task names as static text (not buttons) when onOpenTask is omitted', () => {
    renderWithRouter(
      <SprintBacklogTable
        projectId="proj-1"
        sprintId="sp-1"
        tasks={[task({ id: '1', name: 'Read-only task', status: 'BACKLOG' })]}
      />,
    );
    // The name is still visible, but it is not an interactive open control.
    expect(screen.getByText('Read-only task')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Open Read-only task/i }),
    ).not.toBeInTheDocument();
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

  it('renders the Pull from backlog header link to the Product Backlog when showBacklogLink is set (#1347)', () => {
    renderWithRouter(
      <SprintBacklogTable
        projectId="proj-1"
        sprintId="sp-planned"
        tasks={[task({ id: '1', status: 'NOT_STARTED' })]}
        showBacklogLink
      />,
    );
    const link = screen.getByRole('link', { name: /Pull from backlog/i });
    expect(link).toHaveAttribute('href', '/projects/proj-1/product-backlog');
  });

  it('does not render the Pull from backlog link by default (active/closed surface)', () => {
    renderWithRouter(
      <SprintBacklogTable
        projectId="proj-1"
        sprintId="sp-active"
        tasks={[task({ id: '1', status: 'NOT_STARTED' })]}
      />,
    );
    expect(
      screen.queryByRole('link', { name: /Pull from backlog/i }),
    ).not.toBeInTheDocument();
  });

  it('offers a Product Backlog link in the empty state when showBacklogLink is set (#1347)', () => {
    renderWithRouter(
      <SprintBacklogTable
        projectId="proj-1"
        sprintId="sp-planned"
        tasks={[]}
        onAddTask={vi.fn()}
        showBacklogLink
      />,
    );
    expect(screen.getByText(/Pull existing stories from the/i)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /Product Backlog/i });
    expect(link).toHaveAttribute('href', '/projects/proj-1/product-backlog');
    // The add-a-new-task affordance still stands alongside the backlog handoff.
    expect(
      screen.getAllByRole('button', { name: /\+ Add task/i }).length,
    ).toBeGreaterThan(0);
  });
});
