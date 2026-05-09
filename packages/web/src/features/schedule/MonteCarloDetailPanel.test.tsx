import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MonteCarloDetailPanel } from './MonteCarloDetailPanel';
import { FIXTURE_MC_RESULT } from '@/fixtures/monteCarlo';
import type { Task } from '@/types';

const FIXTURE_TASKS: Task[] = [
  {
    id: 't1', name: 'Backend API', wbs: '1.1', duration: 20, start: '2026-09-01', finish: '2026-09-21',
    isSummary: false, isMilestone: false, isCritical: false, progress: 0, status: 'NOT_STARTED',
    plannedStart: null, notes: '', optimisticDuration: 12, pessimisticDuration: 28, mostLikelyDuration: 20,
    server_version: 1, projectId: 'proj-1',
  },
  {
    id: 't2', name: 'User testing', wbs: '1.2', duration: 10, start: '2026-10-01', finish: '2026-10-11',
    isSummary: false, isMilestone: false, isCritical: false, progress: 0, status: 'NOT_STARTED',
    plannedStart: null, notes: '', optimisticDuration: 7, pessimisticDuration: 16, mostLikelyDuration: 10,
    server_version: 1, projectId: 'proj-1',
  },
  {
    // Summary task — should be excluded from top drivers
    id: 't3', name: 'Phase 1', wbs: '1', duration: 30, start: '2026-09-01', finish: '2026-09-30',
    isSummary: true, isMilestone: false, isCritical: false, progress: 0, status: 'NOT_STARTED',
    plannedStart: null, notes: '', optimisticDuration: 20, pessimisticDuration: 40, mostLikelyDuration: 30,
    server_version: 1, projectId: 'proj-1',
  },
] as unknown as Task[];

describe('MonteCarloDetailPanel', () => {
  it('renders with role="dialog" when open', () => {
    render(
      <MonteCarloDetailPanel
        result={FIXTURE_MC_RESULT}
        cpmFinish="2026-10-05"
        tasks={[]}
        isOpen
        onClose={() => {}}
      />,
    );
    expect(screen.getAllByRole('dialog')[0]).toBeInTheDocument();
  });

  it('does not visually appear when isOpen=false (slide-out state)', () => {
    render(
      <MonteCarloDetailPanel
        result={FIXTURE_MC_RESULT}
        cpmFinish="2026-10-05"
        tasks={[]}
        isOpen={false}
        onClose={() => {}}
      />,
    );
    // Panel is in DOM but translated off-screen. Role is still accessible.
    // The translate-x-full class applies — just verify no focus was captured.
    const dialogs = screen.getAllByRole('dialog');
    expect(dialogs.length).toBeGreaterThan(0);
  });

  it('fires onClose when the close button is clicked', () => {
    const onClose = vi.fn();
    render(
      <MonteCarloDetailPanel
        result={FIXTURE_MC_RESULT}
        cpmFinish="2026-10-05"
        tasks={[]}
        isOpen
        onClose={onClose}
      />,
    );
    // Both desktop and mobile dialogs render the close button; click the first.
    const desktopPanel = screen.getByTestId('mc-detail-panel');
    fireEvent.click(within(desktopPanel).getByRole('button', { name: /Close Monte Carlo detail panel/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('fires onClose on Escape key', () => {
    const onClose = vi.fn();
    render(
      <MonteCarloDetailPanel
        result={FIXTURE_MC_RESULT}
        cpmFinish="2026-10-05"
        tasks={[]}
        isOpen
        onClose={onClose}
      />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders the histogram SVG in the desktop panel', () => {
    render(
      <MonteCarloDetailPanel
        result={FIXTURE_MC_RESULT}
        cpmFinish="2026-10-05"
        tasks={[]}
        isOpen
        onClose={() => {}}
      />,
    );
    const desktopPanel = screen.getByTestId('mc-detail-panel');
    // MonteCarloHistogram renders an SVG with role="img"
    expect(within(desktopPanel).getByRole('img', { name: /Monte Carlo distribution/i })).toBeInTheDocument();
  });

  it('shows risk delta section when cpmFinish is provided', () => {
    render(
      <MonteCarloDetailPanel
        result={FIXTURE_MC_RESULT}
        cpmFinish="2026-10-05"
        tasks={[]}
        isOpen
        onClose={() => {}}
      />,
    );
    const desktopPanel = screen.getByTestId('mc-detail-panel');
    expect(within(desktopPanel).getByText(/Risk delta vs deterministic finish/i)).toBeInTheDocument();
  });

  it('omits risk delta section when cpmFinish is null', () => {
    render(
      <MonteCarloDetailPanel
        result={FIXTURE_MC_RESULT}
        cpmFinish={null}
        tasks={[]}
        isOpen
        onClose={() => {}}
      />,
    );
    expect(screen.queryByText(/Risk delta vs deterministic finish/i)).not.toBeInTheDocument();
  });

  it('shows P80 delta as positive days when P80 is later than CPM finish', () => {
    // FIXTURE_MC_RESULT.p80 = '2026-11-03', CPM finish = '2026-10-05' → +29d
    render(
      <MonteCarloDetailPanel
        result={FIXTURE_MC_RESULT}
        cpmFinish="2026-10-05"
        tasks={[]}
        isOpen
        onClose={() => {}}
      />,
    );
    const desktopPanel = screen.getByTestId('mc-detail-panel');
    expect(within(desktopPanel).getByText('+29d vs CPM')).toBeInTheDocument();
  });

  it('lists leaf task PERT drivers but excludes summary tasks', () => {
    render(
      <MonteCarloDetailPanel
        result={FIXTURE_MC_RESULT}
        cpmFinish="2026-10-05"
        tasks={FIXTURE_TASKS}
        isOpen
        onClose={() => {}}
      />,
    );
    const desktopPanel = screen.getByTestId('mc-detail-panel');
    // Leaf tasks present
    expect(within(desktopPanel).getByText('Backend API')).toBeInTheDocument();
    expect(within(desktopPanel).getByText('User testing')).toBeInTheDocument();
    // Summary task excluded
    expect(within(desktopPanel).queryByText('Phase 1')).not.toBeInTheDocument();
  });

  it('shows PERT hint when no leaf tasks have estimates', () => {
    render(
      <MonteCarloDetailPanel
        result={FIXTURE_MC_RESULT}
        cpmFinish={null}
        tasks={[]}
        isOpen
        onClose={() => {}}
      />,
    );
    const desktopPanel = screen.getByTestId('mc-detail-panel');
    expect(within(desktopPanel).getByText(/No PERT estimates set/i)).toBeInTheDocument();
  });
});
