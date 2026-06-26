import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SchedulePulse } from './SchedulePulse';

const useProjectScheduleSummary = vi.fn();
const useActiveSprint = vi.fn();
const useScheduleTasks = vi.fn();
const useProject = vi.fn();
const registryGet = vi.fn(() => [] as unknown[]);

vi.mock('./useProjectScheduleSummary', () => ({
  useProjectScheduleSummary: () => useProjectScheduleSummary() as Record<string, unknown>,
}));
vi.mock('@/hooks/useSprints', () => ({
  useActiveSprint: () => useActiveSprint() as Record<string, unknown>,
}));
vi.mock('@/hooks/useScheduleTasks', () => ({
  useScheduleTasks: () => useScheduleTasks() as Record<string, unknown>,
}));
vi.mock('@/hooks/useProject', () => ({
  useProject: () => useProject() as Record<string, unknown>,
}));
vi.mock('@/lib/widget-registry', () => ({
  registry: { get: () => registryGet() },
}));

const OVERVIEW = {
  schedule_health: 'at_risk',
  spi: 0.92,
  tasks_late_count: 2,
  critical_task_count: 5,
  total_tasks: 20,
  complete_tasks: 5,
  next_milestone: { id: 'm1', name: 'Beta', date: '2026-07-01', percent_complete: 40 },
};

const SPRINT = { id: 'sp-1', name: 'Sprint 14', goal: 'Checkout polish' };

function task(over: Record<string, unknown>) {
  return { id: 'task', sprintId: 'sp-1', status: 'NOT_STARTED', ...over };
}

describe('SchedulePulse', () => {
  beforeEach(() => {
    useProjectScheduleSummary.mockReturnValue({ data: OVERVIEW, isLoading: false, error: null });
    useActiveSprint.mockReturnValue({ sprint: SPRINT, isLoading: false });
    useScheduleTasks.mockReturnValue({ tasks: [], isLoading: false });
    // Default HYBRID — the superset — so the existing assertions (both halves) hold.
    useProject.mockReturnValue({ data: { effective_methodology: 'HYBRID' } });
    registryGet.mockReturnValue([]);
  });

  it('renders the schedule-health band with its label and SPI (color is never the only signal)', () => {
    render(<SchedulePulse projectId="p1" />);
    expect(screen.getByTestId('pulse-health')).toHaveTextContent('At risk');
    expect(screen.getByTestId('pulse-health')).toHaveTextContent('SPI 0.92');
  });

  it('renders schedule KPIs from the overview endpoint', () => {
    render(<SchedulePulse projectId="p1" />);
    // 5 / 20 complete → 25%
    expect(screen.getByText('25%')).toBeInTheDocument();
    expect(screen.getByText('Beta · 40%')).toBeInTheDocument();
  });

  it('derives the active sprint percent from board tasks (board → schedule rollup)', () => {
    useScheduleTasks.mockReturnValue({
      tasks: [
        task({ id: 't1', status: 'COMPLETE' }),
        task({ id: 't2', status: 'IN_PROGRESS' }),
        task({ id: 't3', status: 'COMPLETE' }),
        task({ id: 't4', status: 'NOT_STARTED' }),
        task({ id: 'other', sprintId: 'sp-other', status: 'COMPLETE' }), // different sprint — excluded
      ],
      isLoading: false,
    });
    render(<SchedulePulse projectId="p1" />);
    const bar = screen.getByRole('progressbar');
    // 2 of 4 in-sprint tasks complete → 50%
    expect(bar).toHaveAttribute('aria-valuenow', '50');
    expect(screen.getByTestId('pulse-sprint')).toHaveTextContent('Sprint 14');
    expect(screen.getByTestId('pulse-sprint')).toHaveTextContent('2/4 done');
  });

  it('shows a "No active sprint" state when none is active', () => {
    useActiveSprint.mockReturnValue({ sprint: null, isLoading: false });
    render(<SchedulePulse projectId="p1" />);
    expect(screen.getByTestId('pulse-no-sprint')).toHaveTextContent('No active sprint');
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('renders a loading skeleton while the overview is loading', () => {
    useProjectScheduleSummary.mockReturnValue({ data: undefined, isLoading: true, error: null });
    render(<SchedulePulse projectId="p1" />);
    expect(screen.getByLabelText('Loading schedule status')).toBeInTheDocument();
  });

  it('shows an inline error if the overview fails, without crashing the strip', () => {
    useProjectScheduleSummary.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('boom'),
    });
    render(<SchedulePulse projectId="p1" />);
    expect(screen.getByRole('alert')).toHaveTextContent(/Couldn't load schedule status/i);
    // The health band still renders (unknown) and the sprint chip is unaffected.
    expect(screen.getByTestId('pulse-health')).toHaveTextContent('Unknown');
  });

  it('renders nothing for the Enterprise gate slot in OSS (empty registry)', () => {
    registryGet.mockReturnValue([]);
    const { container } = render(<SchedulePulse projectId="p1" />);
    // No registered gate component — the strip has no enterprise card.
    expect(container.querySelector('[data-enterprise-gate]')).toBeNull();
  });

  // Methodology-aware halves (ADR-0107, issue 1338) — read from effective_methodology.
  describe('methodology-aware halves', () => {
    it('WATERFALL: keeps the schedule cluster, drops the sprint rollup', () => {
      useProject.mockReturnValue({ data: { effective_methodology: 'WATERFALL' } });
      render(<SchedulePulse projectId="p1" />);
      // Schedule signals stay — waterfall is plan-driven.
      expect(screen.getByTestId('pulse-health')).toBeInTheDocument();
      expect(screen.getByText('25%')).toBeInTheDocument();
      // No sprints on waterfall → the rollup half (and its empty state) is gone.
      expect(screen.queryByTestId('pulse-sprint')).not.toBeInTheDocument();
      expect(screen.queryByTestId('pulse-no-sprint')).not.toBeInTheDocument();
    });

    it('AGILE: drops the CPM/SPI cluster, keeps the sprint rollup', () => {
      useProject.mockReturnValue({ data: { effective_methodology: 'AGILE' } });
      useScheduleTasks.mockReturnValue({
        tasks: [task({ id: 't1', status: 'COMPLETE' }), task({ id: 't2', status: 'NOT_STARTED' })],
        isLoading: false,
      });
      render(<SchedulePulse projectId="p1" />);
      // The schedule-pulse cluster is off-vocabulary on agile → not rendered.
      expect(screen.queryByTestId('pulse-health')).not.toBeInTheDocument();
      expect(screen.queryByText('Complete')).not.toBeInTheDocument();
      expect(screen.queryByText('SPI 0.92')).not.toBeInTheDocument();
      // The sprint rollup is foregrounded and still derives its percent from the board.
      expect(screen.getByTestId('pulse-sprint')).toHaveTextContent('Sprint 14');
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
    });

    it('AGILE: suppresses the schedule skeleton while the overview is loading', () => {
      useProject.mockReturnValue({ data: { effective_methodology: 'AGILE' } });
      useProjectScheduleSummary.mockReturnValue({ data: undefined, isLoading: true, error: null });
      render(<SchedulePulse projectId="p1" />);
      // The skeleton stands in for the (dropped) schedule cluster — don't flash it.
      expect(screen.queryByLabelText('Loading schedule status')).not.toBeInTheDocument();
      expect(screen.getByTestId('pulse-sprint')).toBeInTheDocument();
    });

    it('defaults to HYBRID (both halves) while the project is still loading', () => {
      useProject.mockReturnValue({ data: undefined });
      render(<SchedulePulse projectId="p1" />);
      expect(screen.getByTestId('pulse-health')).toBeInTheDocument();
      expect(screen.getByTestId('pulse-sprint')).toBeInTheDocument();
    });
  });
});
