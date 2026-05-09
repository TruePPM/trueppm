/**
 * Tests for MetaRail — milestone field suppression and predecessor chips (ADR-0058).
 */
import { screen } from '@testing-library/react';
import { vi, describe, it, expect } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { MetaRail } from './MetaRail';
import type { Task, TaskLink } from '@/types';

// ---------------------------------------------------------------------------
// Module mock — useScheduleTasks
// ---------------------------------------------------------------------------

let mockTasks: Task[] = [];
let mockLinks: TaskLink[] = [];

vi.mock('@/hooks/useScheduleTasks', () => ({
  useScheduleTasks: () => ({ tasks: mockTasks, links: mockLinks }),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_TASK: Task = {
  id: 'task-1',
  wbs: '1.1',
  name: 'My Task',
  start: '2026-06-01',
  finish: '2026-06-10',
  duration: 7,
  progress: 40,
  parentId: null,
  isCritical: false,
  isComplete: false,
  isSummary: false,
  isMilestone: false,
  status: 'IN_PROGRESS',
  assignees: [],
  notes: '',
  totalFloat: 3,
};

const MILESTONE_TASK: Task = {
  ...BASE_TASK,
  id: 'ms-1',
  wbs: '1.2',
  name: 'Milestone',
  duration: 0,
  progress: 0,
  isMilestone: true,
  status: 'NOT_STARTED',
};

const PRED_TASK: Task = {
  ...BASE_TASK,
  id: 'pred-1',
  wbs: '1.0',
  name: 'Predecessor',
};

const FS_LINK: TaskLink = {
  id: 'link-1',
  sourceId: 'pred-1',
  targetId: 'task-1',
  type: 'FS',
  lag: 0,
  isCritical: false,
};

const SS_LAG_LINK: TaskLink = {
  id: 'link-2',
  sourceId: 'pred-1',
  targetId: 'task-1',
  type: 'SS',
  lag: 5,
  isCritical: false,
};

// ---------------------------------------------------------------------------
// Regular task — baseline rendering
// ---------------------------------------------------------------------------

describe('MetaRail — regular task', () => {
  it('shows Start and Finish rows', () => {
    mockTasks = [BASE_TASK];
    mockLinks = [];
    renderWithProviders(<MetaRail task={BASE_TASK} />);
    expect(screen.getByRole('group', { name: 'Start' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Finish' })).toBeInTheDocument();
  });

  it('shows duration in days', () => {
    mockTasks = [BASE_TASK];
    mockLinks = [];
    renderWithProviders(<MetaRail task={BASE_TASK} />);
    expect(screen.getByText('7d')).toBeInTheDocument();
  });

  it('shows progress percentage', () => {
    mockTasks = [BASE_TASK];
    mockLinks = [];
    renderWithProviders(<MetaRail task={BASE_TASK} />);
    expect(screen.getByText('40%')).toBeInTheDocument();
  });

  it('shows progress bar', () => {
    mockTasks = [BASE_TASK];
    mockLinks = [];
    renderWithProviders(<MetaRail task={BASE_TASK} />);
    expect(screen.getByRole('progressbar', { name: 'Task progress' })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Milestone — field suppression (ADR-0058)
// ---------------------------------------------------------------------------

describe('MetaRail — milestone field suppression', () => {
  it('labels Start row as "Date" for milestones', () => {
    mockTasks = [MILESTONE_TASK];
    mockLinks = [];
    renderWithProviders(<MetaRail task={MILESTONE_TASK} />);
    expect(screen.getByRole('group', { name: 'Date' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Start' })).not.toBeInTheDocument();
  });

  it('hides Finish row for milestones', () => {
    mockTasks = [MILESTONE_TASK];
    mockLinks = [];
    renderWithProviders(<MetaRail task={MILESTONE_TASK} />);
    expect(screen.queryByRole('group', { name: 'Finish' })).not.toBeInTheDocument();
  });

  it('shows "— (milestone)" instead of duration for milestones', () => {
    mockTasks = [MILESTONE_TASK];
    mockLinks = [];
    renderWithProviders(<MetaRail task={MILESTONE_TASK} />);
    expect(screen.getByText('— (milestone)')).toBeInTheDocument();
    expect(screen.queryByText('0d')).not.toBeInTheDocument();
  });

  it('shows "Not yet reached" when milestone progress < 100', () => {
    mockTasks = [MILESTONE_TASK];
    mockLinks = [];
    renderWithProviders(<MetaRail task={{ ...MILESTONE_TASK, progress: 0 }} />);
    expect(screen.getByText('Not yet reached')).toBeInTheDocument();
  });

  it('shows "✓ Reached" when milestone progress >= 100', () => {
    mockTasks = [MILESTONE_TASK];
    mockLinks = [];
    renderWithProviders(<MetaRail task={{ ...MILESTONE_TASK, progress: 100 }} />);
    expect(screen.getByText('✓ Reached')).toBeInTheDocument();
  });

  it('hides the progress bar for milestones', () => {
    mockTasks = [MILESTONE_TASK];
    mockLinks = [];
    renderWithProviders(<MetaRail task={MILESTONE_TASK} />);
    expect(screen.queryByRole('progressbar', { name: 'Task progress' })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Predecessor chips (ADR-0058)
// ---------------------------------------------------------------------------

describe('MetaRail — predecessor chips', () => {
  it('shows "—" when no predecessors', () => {
    mockTasks = [BASE_TASK];
    mockLinks = [];
    renderWithProviders(<MetaRail task={BASE_TASK} />);
    const predGroup = screen.getByRole('group', { name: 'Predecessors' });
    expect(predGroup.textContent).toMatch(/—/);
  });

  it('renders a chip for an FS predecessor with WBS + type', () => {
    mockTasks = [BASE_TASK, PRED_TASK];
    mockLinks = [FS_LINK];
    renderWithProviders(<MetaRail task={BASE_TASK} />);
    expect(screen.getByText('1.0 FS')).toBeInTheDocument();
  });

  it('renders lag suffix on chip when lag is non-zero', () => {
    mockTasks = [BASE_TASK, PRED_TASK];
    mockLinks = [SS_LAG_LINK];
    renderWithProviders(<MetaRail task={BASE_TASK} />);
    expect(screen.getByText('1.0 SS+5')).toBeInTheDocument();
  });

  it('chip title tooltip contains full dep-type label', () => {
    mockTasks = [BASE_TASK, PRED_TASK];
    mockLinks = [FS_LINK];
    renderWithProviders(<MetaRail task={BASE_TASK} />);
    const chip = screen.getByText('1.0 FS');
    expect(chip).toHaveAttribute('title', 'Finish → Start');
  });

  it('chip title includes lag description when lag > 0', () => {
    mockTasks = [BASE_TASK, PRED_TASK];
    mockLinks = [SS_LAG_LINK];
    renderWithProviders(<MetaRail task={BASE_TASK} />);
    const chip = screen.getByText('1.0 SS+5');
    expect(chip).toHaveAttribute('title', 'Start → Start, +5 days lag');
  });
});
