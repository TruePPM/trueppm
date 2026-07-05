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

  it('self-suppresses when there is no sprint, nothing critical, and no forecast', () => {
    const { container } = renderWithRouter(
      <MyWorkSideColumn tasks={[task()]} activeSprints={[]} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders the real Monte-Carlo P80 ship-date forecast panel (#1236)', () => {
    renderWithRouter(
      <MyWorkSideColumn
        tasks={[task()]}
        activeSprints={[]}
        forecast={{
          p80_finish: '2026-08-14',
          project_id: 'p9',
          project_name: 'Apollo Platform',
          as_of: '2026-07-01T09:12:00Z',
        }}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Ship-date forecast' })).toBeInTheDocument();
    // The date is real accessible text (not color-only), with confidence context.
    expect(screen.getByText('Aug 14, 2026')).toBeInTheDocument();
    expect(screen.getByText(/Apollo Platform · 80% confidence · as of/)).toBeInTheDocument();
  });

  it('renders the forecast panel even when the user has no sprint or critical work', () => {
    const { container } = renderWithRouter(
      <MyWorkSideColumn
        tasks={[task()]}
        activeSprints={[]}
        forecast={{
          p80_finish: '2026-08-14',
          project_id: 'p9',
          project_name: 'Apollo Platform',
          as_of: '2026-07-01T09:12:00Z',
        }}
      />,
    );
    // The column no longer self-suppresses because a real forecast exists.
    expect(container.firstChild).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'Ship-date forecast' })).toBeInTheDocument();
  });
});
