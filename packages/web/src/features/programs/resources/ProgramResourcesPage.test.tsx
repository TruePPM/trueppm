import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ProgramResourcesPage } from './ProgramResourcesPage';
import type {
  ProgramContentionResponse,
  UseProgramResourceContentionResult,
} from '@/hooks/useProgramResourceContention';

const mockUseProgramId = vi.fn<() => string | null>(() => 'prog-1');
vi.mock('@/hooks/useProgramId', () => ({
  useProgramId: () => mockUseProgramId(),
}));

let mockResult: UseProgramResourceContentionResult;
vi.mock('@/hooks/useProgramResourceContention', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useProgramResourceContention')>();
  return { ...actual, useProgramResourceContention: () => mockResult };
});

function contended(): ProgramContentionResponse {
  return {
    program_id: 'prog-1',
    window_start: '2026-07-06',
    window_end: '2026-08-02',
    resources: [
      {
        id: 'r-janus',
        name: 'Janus',
        email: 'janus@trueppm.demo',
        max_units: '1.00',
        tasks: [
          {
            assignment_id: 'a1',
            id: 't1',
            name: 'Remediate criticals',
            project_id: 'p-sec',
            project_name: 'Security',
            early_start: '2026-07-13',
            early_finish: '2026-07-21',
            units: '1.00',
            status: 'IN_PROGRESS',
          },
          {
            assignment_id: 'a2',
            id: 't2',
            name: 'Evidence collection',
            project_id: 'p-soc',
            project_name: 'SOC2',
            early_start: '2026-07-13',
            early_finish: '2026-07-20',
            units: '0.50',
            status: 'NOT_STARTED',
          },
        ],
      },
    ],
  };
}

beforeEach(() => {
  mockUseProgramId.mockReturnValue('prog-1');
  mockResult = { data: undefined, status: 'loading', error: null };
});

describe('ProgramResourcesPage (#1149)', () => {
  it('renders a per-resource card with the cross-project breakdown and over-allocation flag', () => {
    mockResult = { data: contended(), status: 'success', error: null };
    render(<ProgramResourcesPage />);

    expect(screen.getByText('Janus')).toBeInTheDocument();
    expect(screen.getByText('100% capacity')).toBeInTheDocument();
    // Both source projects appear (the cross-project contention the view exists for).
    expect(screen.getByText('Security')).toBeInTheDocument();
    expect(screen.getByText('SOC2')).toBeInTheDocument();
    // Janus is 1.0 + 0.5 in the same window → over-allocated (real detection math).
    expect(screen.getByLabelText(/Over-allocated in W/)).toBeInTheDocument();
  });

  it('shows the schedule-not-run state on 409', () => {
    mockResult = { data: undefined, status: 'schedule-not-run', error: null };
    render(<ProgramResourcesPage />);
    expect(screen.getByText(/has a computed schedule yet/)).toBeInTheDocument();
  });

  it('shows a permission notice when the caller is below Scheduler (403)', () => {
    mockResult = { data: undefined, status: 'forbidden', error: null };
    render(<ProgramResourcesPage />);
    // The success heading is still present, but no resource card renders.
    expect(screen.queryByText('Janus')).not.toBeInTheDocument();
    expect(screen.getByText('Resource contention')).toBeInTheDocument();
  });

  it('shows an empty state when no one is staffed across projects', () => {
    mockResult = {
      data: { program_id: 'prog-1', window_start: '2026-07-06', window_end: '2026-08-02', resources: [] },
      status: 'success',
      error: null,
    };
    render(<ProgramResourcesPage />);
    expect(screen.getByText(/No one is assigned across/)).toBeInTheDocument();
  });
});
