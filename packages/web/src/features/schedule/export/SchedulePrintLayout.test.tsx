import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SchedulePrintLayout } from './SchedulePrintLayout';
import { buildSchedulePrintData } from './schedulePrintData';
import type { Task, TaskLink } from '@/types';

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    wbs: id,
    name: `Task ${id}`,
    start: '2026-04-01',
    finish: '2026-04-05',
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
  } as Task;
}

const link: TaskLink = {
  id: 'l1',
  sourceId: 'a',
  targetId: 'b',
  type: 'FS',
  lag: 0,
  isCritical: true,
};

function data() {
  return buildSchedulePrintData({
    projectName: 'Apollo',
    tasks: [
      task('a', {
        wbs: '1',
        name: 'Design',
        start: '2026-04-01',
        finish: '2026-04-08',
        isCritical: true,
      }),
      task('b', {
        wbs: '2',
        name: 'Build',
        start: '2026-04-09',
        finish: '2026-04-20',
        isCritical: true,
      }),
      task('m', {
        wbs: '3',
        name: 'Launch',
        isMilestone: true,
        start: '2026-04-21',
        finish: '2026-04-21',
      }),
    ],
    links: [link],
    userName: 'Jane',
    generatedAtLabel: 'Jun 30, 2026',
  });
}

describe('SchedulePrintLayout', () => {
  it('renders the masthead, KPI strip, rows, and a dependency arrow path', () => {
    const { container } = render(<SchedulePrintLayout data={data()} />);

    expect(screen.getByText('Apollo')).toBeInTheDocument();
    expect(screen.getByText('Window')).toBeInTheDocument();
    expect(screen.getByText('Critical path')).toBeInTheDocument();
    // "Design" appears in both the row label and the critical-path footer chain.
    expect(screen.getAllByText(/Design/).length).toBeGreaterThanOrEqual(1);

    // The FS link is re-projected as an SVG connector path + arrowhead polygon.
    expect(container.querySelectorAll('svg path').length).toBeGreaterThanOrEqual(1);
    expect(container.querySelectorAll('svg polygon').length).toBeGreaterThanOrEqual(1);
  });

  it('renders an empty state when no rows are dated', () => {
    const empty = buildSchedulePrintData({
      projectName: 'Empty',
      tasks: [],
      links: [],
      userName: null,
      generatedAtLabel: 'Jun 30, 2026',
    });
    render(<SchedulePrintLayout data={empty} />);
    expect(screen.getByText(/No activities to plot/)).toBeInTheDocument();
  });

  it('honors the A4 paper width without throwing', () => {
    const { container } = render(<SchedulePrintLayout data={data()} paper="a4" />);
    expect(container.firstChild).toBeTruthy();
  });
});
