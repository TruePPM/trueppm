/**
 * RiskPopover — covers loading state, empty state, risk list rendering,
 * severityRagBand/severityDotCount display, status labels, and close/navigate actions.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { RiskPopover } from './RiskPopover';
import type { Task } from '@/types';
import type { TaskRiskSummary } from '@/hooks/useTaskDependencies';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockRisksResult: { risks: TaskRiskSummary[]; isLoading: boolean; error: Error | null } = {
  risks: [],
  isLoading: false,
  error: null,
};

const mockNavigate = vi.fn();

vi.mock('@/hooks/useTaskDependencies', () => ({
  useTaskRisks: () => mockRisksResult,
  severityRagBand: (severity: number | null | undefined) => {
    if (severity == null || severity <= 0) return null;
    if (severity <= 5) return 'green';
    if (severity <= 14) return 'amber';
    return 'red';
  },
  severityDotCount: (severity: number | null | undefined): number => {
    if (severity == null || severity <= 0) return 0;
    if (severity === 1) return 1;
    if (severity <= 5) return 2;
    if (severity <= 11) return 3;
    if (severity <= 19) return 4;
    return 5;
  },
}));

vi.mock('react-router', () => ({
  useNavigate: () => mockNavigate,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    wbs: '1',
    name: 'Alpha Task',
    start: '2026-01-01',
    finish: '2026-01-08',
    duration: 7,
    progress: 0,
    parentId: null,
    isCritical: false,
    isComplete: false,
    isSummary: false,
    isMilestone: false,
    status: 'NOT_STARTED',
    assignees: [],
    ...overrides,
  };
}

function makeRisk(overrides: Partial<TaskRiskSummary> = {}): TaskRiskSummary {
  return {
    id: 'r1',
    shortId: 'RSK-001',
    title: 'Budget overrun',
    status: 'OPEN',
    severity: 12,
    ownerId: null,
    ...overrides,
  };
}

describe('RiskPopover', () => {
  const baseTask = makeTask();
  const onClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockRisksResult.risks = [];
    mockRisksResult.isLoading = false;
    mockRisksResult.error = null;
  });

  it('renders the dialog with accessible role', () => {
    render(<RiskPopover projectId="proj1" task={baseTask} onClose={onClose} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('renders "Linked risks" heading', () => {
    render(<RiskPopover projectId="proj1" task={baseTask} onClose={onClose} />);
    expect(screen.getByText('Linked risks')).toBeInTheDocument();
  });

  it('renders the task name in the header', () => {
    render(<RiskPopover projectId="proj1" task={baseTask} onClose={onClose} />);
    expect(screen.getByText('Alpha Task')).toBeInTheDocument();
  });

  it('shows loading state', () => {
    mockRisksResult.isLoading = true;
    render(<RiskPopover projectId="proj1" task={baseTask} onClose={onClose} />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('shows empty state when no risks', () => {
    render(<RiskPopover projectId="proj1" task={baseTask} onClose={onClose} />);
    expect(screen.getByText('No active risks linked.')).toBeInTheDocument();
  });

  it('calls onClose when close button is clicked', () => {
    render(<RiskPopover projectId="proj1" task={baseTask} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close risk list' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when the backdrop is pointer-downed', () => {
    render(<RiskPopover projectId="proj1" task={baseTask} onClose={onClose} />);
    fireEvent.pointerDown(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not call onClose when inner content is pointer-downed', () => {
    render(<RiskPopover projectId="proj1" task={baseTask} onClose={onClose} />);
    fireEvent.pointerDown(screen.getByText('Linked risks'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('renders a risk row with title and short ID', () => {
    mockRisksResult.risks = [makeRisk()];
    render(<RiskPopover projectId="proj1" task={baseTask} onClose={onClose} />);
    expect(screen.getByText('Budget overrun')).toBeInTheDocument();
    expect(screen.getByText('RSK-001')).toBeInTheDocument();
  });

  it('renders the correct status label for OPEN risk', () => {
    mockRisksResult.risks = [makeRisk({ status: 'OPEN' })];
    render(<RiskPopover projectId="proj1" task={baseTask} onClose={onClose} />);
    expect(screen.getByText('Open')).toBeInTheDocument();
  });

  it('renders the correct status label for MITIGATING risk', () => {
    mockRisksResult.risks = [makeRisk({ status: 'MITIGATING' })];
    render(<RiskPopover projectId="proj1" task={baseTask} onClose={onClose} />);
    expect(screen.getByText('Mitigating')).toBeInTheDocument();
  });

  it('renders the correct status label for RESOLVED risk', () => {
    mockRisksResult.risks = [makeRisk({ status: 'RESOLVED' })];
    render(<RiskPopover projectId="proj1" task={baseTask} onClose={onClose} />);
    expect(screen.getByText('Resolved')).toBeInTheDocument();
  });

  it('renders the correct status label for ACCEPTED risk', () => {
    mockRisksResult.risks = [makeRisk({ status: 'ACCEPTED' })];
    render(<RiskPopover projectId="proj1" task={baseTask} onClose={onClose} />);
    expect(screen.getByText('Accepted')).toBeInTheDocument();
  });

  it('renders the correct status label for CLOSED risk', () => {
    mockRisksResult.risks = [makeRisk({ status: 'CLOSED' })];
    render(<RiskPopover projectId="proj1" task={baseTask} onClose={onClose} />);
    expect(screen.getByText('Closed')).toBeInTheDocument();
  });

  it('renders the severity value', () => {
    mockRisksResult.risks = [makeRisk({ severity: 12 })];
    render(<RiskPopover projectId="proj1" task={baseTask} onClose={onClose} />);
    expect(screen.getByLabelText('Severity 12 of 25')).toBeInTheDocument();
  });

  it('renders severity dots (HIGH → 4 dots for severity 12)', () => {
    mockRisksResult.risks = [makeRisk({ severity: 12 })];
    const { container } = render(
      <RiskPopover projectId="proj1" task={baseTask} onClose={onClose} />,
    );
    // SeverityDots renders inline-block dots; severity 12 → severityDotCount = 4
    const dots = container.querySelectorAll('span.inline-block.w-1\\.5.h-1\\.5.rounded-full');
    expect(dots.length).toBe(4);
  });

  it('renders green dot color for low severity (≤5)', () => {
    mockRisksResult.risks = [makeRisk({ severity: 4 })];
    const { container } = render(
      <RiskPopover projectId="proj1" task={baseTask} onClose={onClose} />,
    );
    const greenDot = container.querySelector('.bg-semantic-on-track');
    expect(greenDot).toBeTruthy();
  });

  it('renders red dot color for critical severity (≥15)', () => {
    mockRisksResult.risks = [makeRisk({ severity: 20 })];
    const { container } = render(
      <RiskPopover projectId="proj1" task={baseTask} onClose={onClose} />,
    );
    const redDot = container.querySelector('.bg-semantic-critical');
    expect(redDot).toBeTruthy();
  });

  it('renders amber dot color for medium severity (6–14)', () => {
    mockRisksResult.risks = [makeRisk({ severity: 10 })];
    const { container } = render(
      <RiskPopover projectId="proj1" task={baseTask} onClose={onClose} />,
    );
    const amberDot = container.querySelector('.bg-brand-accent-dark');
    expect(amberDot).toBeTruthy();
  });

  it('calls onClose and navigates when "Open in risk register" is clicked', () => {
    render(<RiskPopover projectId="proj1" task={baseTask} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /Open in risk register/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('/projects/proj1/risks');
  });

  it('renders multiple risks as a list', () => {
    mockRisksResult.risks = [
      makeRisk({ id: 'r1', shortId: 'RSK-001', title: 'Risk One' }),
      makeRisk({ id: 'r2', shortId: 'RSK-002', title: 'Risk Two' }),
    ];
    render(<RiskPopover projectId="proj1" task={baseTask} onClose={onClose} />);
    expect(screen.getByText('Risk One')).toBeInTheDocument();
    expect(screen.getByText('Risk Two')).toBeInTheDocument();
  });
});
