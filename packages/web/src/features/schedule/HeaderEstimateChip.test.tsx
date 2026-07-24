import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Task } from '@/types';
import { HeaderEstimateChip } from './HeaderEstimateChip';

// Mutable project stub so each test picks the methodology / scale it needs.
let project: { effective_methodology: string; effective_estimation_scale: string } | undefined;
vi.mock('@/hooks/useProject', () => ({
  useProject: () => ({ data: project }),
}));

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    wbs: '1',
    name: 'Task',
    start: '2026-01-13',
    finish: '2026-01-28',
    duration: 12,
    progress: 0,
    parentId: null,
    isCritical: false,
    isComplete: false,
    isSummary: false,
    isMilestone: false,
    status: 'IN_PROGRESS',
    readiness: 'estimated',
    assignees: [],
    notes: '',
    totalFloat: 3,
    ...overrides,
  };
}

describe('HeaderEstimateChip (#2315 slice 3)', () => {
  beforeEach(() => {
    project = { effective_methodology: 'AGILE', effective_estimation_scale: 'fibonacci' };
  });

  it('labels a points estimate as "{pts} pts · {Readiness}"', () => {
    render(<HeaderEstimateChip task={makeTask({ storyPoints: 5, readiness: 'estimated' })} projectId="p1" />);
    expect(screen.getByText('5 pts')).toBeInTheDocument();
    expect(screen.getByText('Estimated')).toBeInTheDocument();
  });

  it('renders a T-shirt size without the " pts" unit', () => {
    project = { effective_methodology: 'AGILE', effective_estimation_scale: 'tshirt' };
    render(<HeaderEstimateChip task={makeTask({ storyPoints: 3, readiness: 'ready' })} projectId="p1" />);
    // 3 → "M" on the T-shirt scale; no " pts" suffix.
    expect(screen.getByText('M')).toBeInTheDocument();
    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.queryByText(/pts/)).not.toBeInTheDocument();
  });

  it('shows amber "Unestimated" for a points-based leaf with no estimate', () => {
    render(<HeaderEstimateChip task={makeTask({ storyPoints: null, readiness: 'idea' })} projectId="p1" />);
    expect(screen.getByText('Unestimated')).toBeInTheDocument();
  });

  it('never scolds a Waterfall task as Unestimated — falls back to the readiness chip', () => {
    project = { effective_methodology: 'WATERFALL', effective_estimation_scale: 'fibonacci' };
    render(<HeaderEstimateChip task={makeTask({ storyPoints: null, readiness: 'estimated' })} projectId="p1" />);
    expect(screen.queryByText('Unestimated')).not.toBeInTheDocument();
    expect(screen.getByText('estimated')).toBeInTheDocument(); // ReadinessChip's lowercase word
  });

  it('never marks a summary/rollup as Unestimated', () => {
    render(
      <HeaderEstimateChip
        task={makeTask({ storyPoints: null, isSummary: true, readiness: 'estimated' })}
        projectId="p1"
      />,
    );
    expect(screen.queryByText('Unestimated')).not.toBeInTheDocument();
  });

  it('renders nothing when there is no estimate, no readiness, and points are not used', () => {
    project = { effective_methodology: 'WATERFALL', effective_estimation_scale: 'fibonacci' };
    const { container } = render(
      <HeaderEstimateChip task={makeTask({ storyPoints: null, readiness: undefined })} projectId="p1" />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
