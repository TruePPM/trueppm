import { screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { MyWorkSideColumn } from './MyWorkSideColumn';
import type { MyWorkTask, MyWorkActiveSprint } from '@/hooks/useMyWork';

function task(overrides: Partial<MyWorkTask> = {}): MyWorkTask {
  return {
    id: Math.random().toString(36).slice(2),
    short_id: 'PRJ-1',
    name: 'A task',
    project_id: 'p1',
    project_name: 'Project One',
    program_id: null,
    program_name: null,
    program_color: null,
    sprint_id: null,
    sprint_name: null,
    status: 'IN_PROGRESS',
    story_points: null,
    remaining_points: null,
    due: null,
    due_source: null,
    is_critical: false,
    group: 'today',
    is_blocked: false,
    blocked_reason: '',
    blocker_type: '',
    blocked_age_seconds: null,
    server_version: 1,
    url: '/projects/p1/schedule?task=x',
    ...overrides,
  };
}

function sprint(overrides: Partial<MyWorkActiveSprint> = {}): MyWorkActiveSprint {
  return {
    id: 's1',
    name: 'Sprint 9',
    project_id: 'p1',
    project_name: 'Project One',
    finish_date: '2026-07-01',
    days_remaining: 5,
    task_count: 4,
    ...overrides,
  };
}

describe('MyWorkSideColumn', () => {
  it('renders the active-sprints panel and an on-the-critical-path mini', () => {
    renderWithRouter(
      <MyWorkSideColumn
        tasks={[task({ name: 'Range safety dry-run', is_critical: true })]}
        activeSprints={[sprint()]}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Active sprints' })).toBeInTheDocument();
    expect(screen.getByText('Sprint 9')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'On the critical path' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Range safety dry-run' })).toBeInTheDocument();
  });

  it('caps the critical mini at four rows and shows a +N more line', () => {
    const tasks = Array.from({ length: 6 }, (_, i) =>
      task({ name: `Critical ${i}`, is_critical: true }),
    );
    renderWithRouter(<MyWorkSideColumn tasks={tasks} activeSprints={[]} />);
    expect(screen.getByText('+2 more')).toBeInTheDocument();
  });

  it('self-suppresses when there is no sprint and nothing critical', () => {
    const { container } = renderWithRouter(
      <MyWorkSideColumn tasks={[task()]} activeSprints={[]} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
