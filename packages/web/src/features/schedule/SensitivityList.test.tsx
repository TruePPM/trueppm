import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SensitivityList } from './SensitivityList';
import type { McSensitivity, Task } from '@/types';

function task(id: string, name: string, isCritical = false): Task {
  return {
    id,
    name,
    wbs: '1',
    duration: 5,
    start: '2026-01-01',
    finish: '2026-01-06',
    isSummary: false,
    isMilestone: false,
    isCritical,
    progress: 0,
    status: 'NOT_STARTED',
    plannedStart: null,
    notes: '',
    server_version: 1,
    projectId: 'p1',
  } as unknown as Task;
}

const TASKS: Task[] = [
  task('t1', 'Structural steel', true),
  task('t2', 'MEP rough-in', false),
  task('t3', 'Range safety review', false),
];

describe('SensitivityList (issue 1222)', () => {
  it('renders a bar per task with name and rounded percent', () => {
    const sensitivity: McSensitivity[] = [
      { taskId: 't1', index: 0.92 },
      { taskId: 't2', index: 0.224 },
    ];
    render(<SensitivityList sensitivity={sensitivity} tasks={TASKS} />);
    expect(screen.getByText('Structural steel')).toBeInTheDocument();
    expect(screen.getByText('92%')).toBeInTheDocument();
    expect(screen.getByText('MEP rough-in')).toBeInTheDocument();
    expect(screen.getByText('22%')).toBeInTheDocument(); // 0.224 → 22
  });

  it('labels each bar accessibly with percent and critical-path status', () => {
    render(<SensitivityList sensitivity={[{ taskId: 't1', index: 0.9 }]} tasks={TASKS} />);
    expect(
      screen.getByRole('img', { name: /Structural steel: 90% sensitivity, on the critical path/i }),
    ).toBeInTheDocument();
  });

  it('drops entries whose task is no longer in the list', () => {
    const sensitivity: McSensitivity[] = [
      { taskId: 't1', index: 0.9 },
      { taskId: 'deleted', index: 0.8 },
    ];
    render(<SensitivityList sensitivity={sensitivity} tasks={TASKS} />);
    expect(screen.getAllByRole('img')).toHaveLength(1);
  });

  it('honors the limit', () => {
    const sensitivity: McSensitivity[] = [
      { taskId: 't1', index: 0.9 },
      { taskId: 't2', index: 0.5 },
      { taskId: 't3', index: 0.2 },
    ];
    render(<SensitivityList sensitivity={sensitivity} tasks={TASKS} limit={2} />);
    expect(screen.getAllByRole('img')).toHaveLength(2);
  });

  it('renders an explanatory empty state when there is no sensitivity', () => {
    render(<SensitivityList sensitivity={[]} tasks={TASKS} />);
    expect(screen.getByText(/No task moved the finish enough to rank/i)).toBeInTheDocument();
    expect(screen.queryAllByRole('img')).toHaveLength(0);
  });

  it('fills critical-path bars with the critical color, others with brand-primary', () => {
    render(
      <SensitivityList
        sensitivity={[
          { taskId: 't1', index: 0.9 }, // critical
          { taskId: 't2', index: 0.5 }, // not critical
        ]}
        tasks={TASKS}
      />,
    );
    const critBar = screen.getByRole('img', { name: /Structural steel/i });
    const normalBar = screen.getByRole('img', { name: /MEP rough-in/i });
    expect(critBar.querySelector('.bg-semantic-critical')).not.toBeNull();
    expect(normalBar.querySelector('.bg-brand-primary')).not.toBeNull();
  });
});
