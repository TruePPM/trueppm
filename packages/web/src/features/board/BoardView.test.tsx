import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { BoardView } from './BoardView';
import { FIXTURE_TASKS } from '@/fixtures/tasks';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@/hooks/useProjectId', () => ({
  useProjectId: () => 'project-1',
}));

vi.mock('@/hooks/useGanttTasks', () => ({
  useGanttTasks: () => ({ tasks: FIXTURE_TASKS, isLoading: false }),
}));

vi.mock('@/hooks/useBoardTasks', () => ({
  useUpdateTaskStatus: () => ({ mutate: vi.fn() }),
}));

vi.mock('@/hooks/useBoardConfig', () => ({
  useBoardConfig: () => ({
    columns: [
      { status: 'NOT_STARTED', label: 'TO DO',        visible: true },
      { status: 'IN_PROGRESS', label: 'IN PROGRESS',  visible: true },
      { status: 'ON_HOLD',     label: 'ON HOLD',      visible: true },
      { status: 'COMPLETE',    label: 'DONE',          visible: true },
    ],
    isLoading: false,
    save: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BoardView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders column headers', () => {
    render(<BoardView />);
    expect(screen.getByText('TO DO')).toBeInTheDocument();
    expect(screen.getByText('IN PROGRESS')).toBeInTheDocument();
    expect(screen.getByText('ON HOLD')).toBeInTheDocument();
    expect(screen.getByText('DONE')).toBeInTheDocument();
  });

  it('renders the phase swimlane for the summary task', () => {
    render(<BoardView />);
    // t1 is a summary task "Alpha Platform Upgrade" — it becomes a lane header
    expect(screen.getByText('Alpha Platform Upgrade')).toBeInTheDocument();
  });

  it('renders an "Other" lane for ungrouped tasks', () => {
    render(<BoardView />);
    // t7 "Documentation" has no summary parent — appears in "Other" lane
    expect(screen.getByText('Other')).toBeInTheDocument();
    expect(screen.getByText('Documentation')).toBeInTheDocument();
  });

  it('does not render summary tasks as cards', () => {
    render(<BoardView />);
    // "Alpha Platform Upgrade" is a summary task — it should not appear as a card
    // but it CAN appear as a lane label. We verify there's no card role for it.
    const allButtons = screen.getAllByRole('button');
    const cardButtons = allButtons.filter(
      (btn) => btn.getAttribute('aria-label')?.includes('Alpha Platform Upgrade'),
    );
    expect(cardButtons).toHaveLength(0);
  });

  it('renders leaf task cards inside the phase lane', () => {
    render(<BoardView />);
    // "Discovery & Design" (t2, COMPLETE) and "Backend Implementation" (t3, IN_PROGRESS)
    // should appear as cards
    expect(screen.getByText('Discovery & Design')).toBeInTheDocument();
    expect(screen.getByText('Backend Implementation')).toBeInTheDocument();
  });

  it('renders CP rpill for critical tasks', () => {
    render(<BoardView />);
    // t3 "Backend Implementation" is critical — should show a CP pill
    const cpPills = screen.getAllByText('CP');
    expect(cpPills.length).toBeGreaterThan(0);
  });

  it('collapses a phase lane on header click', async () => {
    const user = userEvent.setup();
    render(<BoardView />);
    // Expand toggle button for "Alpha Platform Upgrade" phase
    const toggleBtn = screen.getByRole('button', { name: /Alpha Platform Upgrade/ });
    // Initially expanded — task cards visible
    expect(screen.getByText('Discovery & Design')).toBeInTheDocument();

    await user.click(toggleBtn);
    // After collapse, task cards in that lane should be hidden
    expect(screen.queryByText('Discovery & Design')).not.toBeInTheDocument();
  });

  it('shows WIP toggle in toolbar', () => {
    render(<BoardView />);
    expect(screen.getByLabelText('Show WIP limits')).toBeInTheDocument();
  });

});
