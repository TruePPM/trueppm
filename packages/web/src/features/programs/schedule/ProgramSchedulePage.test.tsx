import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProgramSchedulePage } from './ProgramSchedulePage';
import { transformProgramSchedule } from './transformProgramSchedule';
import { HEADER_HEIGHT, ROW_HEIGHT } from '@/features/schedule/scheduleConstants';
import type { ProgramSchedule } from '../hooks/useProgramSchedule';

const useProgramSchedule = vi.fn<() => unknown>();
vi.mock('../hooks/useProgramSchedule', async (orig) => {
  const actual = await orig<typeof import('../hooks/useProgramSchedule')>();
  return { ...actual, useProgramSchedule: () => useProgramSchedule() };
});

const useProgram = vi.fn<() => unknown>();
vi.mock('@/hooks/useProgram', () => ({ useProgram: () => useProgram() }));

const useBreakpoint = vi.fn(() => 'lg');
vi.mock('@/hooks/useBreakpoint', () => ({ useBreakpoint: () => useBreakpoint() }));

// Stub the canvas engine + live-sync sockets + zoom control — this is a
// chrome/state test, not a rendering test (the engine has its own coverage).
vi.mock('@/features/schedule/CanvasScheduleTimeline', () => ({
  CanvasScheduleTimeline: () => <div data-testid="canvas-timeline" />,
}));
vi.mock('./ProgramScheduleLiveSync', () => ({ ProgramScheduleLiveSync: () => null }));
vi.mock('@/features/schedule/ZoomControl', () => ({
  ZoomControl: () => <div data-testid="zoom-control" />,
}));

function axiosError(status: number, data?: unknown): unknown {
  return { isAxiosError: true, response: { status, data } };
}

function queryResult(over: Record<string, unknown>) {
  return {
    data: undefined,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
    isRefetching: false,
    ...over,
  };
}

const GOLDEN: ProgramSchedule = {
  program_id: 'prog-1',
  start_date: '2026-03-02',
  finish_date: '2026-05-01',
  projects: [
    { id: 'proj-a', name: 'Helios Platform', accessible: true },
    { id: 'proj-b', name: 'Helios Mobile', accessible: true },
  ],
  tasks: [
    {
      id: 't-a1',
      name: 'Design API',
      hex_id: 'A-1',
      project_id: 'proj-a',
      is_milestone: false,
      is_external: false,
      wbs_path: '1.1',
      early_start: '2026-03-02',
      early_finish: '2026-03-13',
      late_start: '2026-03-02',
      late_finish: '2026-03-13',
      total_float_days: 0,
      is_critical: true,
    },
  ],
  links: [],
  critical_path: ['t-a1'],
  cross_project_edge_count: 0,
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/programs/prog-1/schedule']}>
      <Routes>
        <Route path="/programs/:programId/schedule" element={<ProgramSchedulePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ProgramSchedulePage', () => {
  beforeEach(() => {
    useBreakpoint.mockReturnValue('lg');
    useProgram.mockReturnValue({ data: { id: 'prog-1', name: 'Helios' } });
  });

  it('shows a larger-screen notice on small viewports', () => {
    useBreakpoint.mockReturnValue('sm');
    useProgramSchedule.mockReturnValue(queryResult({ data: GOLDEN }));
    renderPage();
    expect(screen.getByText('Best viewed on a larger screen')).toBeInTheDocument();
    expect(screen.queryByTestId('canvas-timeline')).not.toBeInTheDocument();
  });

  it('shows a loading skeleton while fetching', () => {
    useProgramSchedule.mockReturnValue(queryResult({ isLoading: true }));
    renderPage();
    expect(screen.getByLabelText('Loading program schedule')).toBeInTheDocument();
  });

  it('renders the golden path: header, project count, legend, and canvas', () => {
    useProgramSchedule.mockReturnValue(queryResult({ data: GOLDEN }));
    renderPage();
    expect(screen.getByRole('heading', { name: 'Program Schedule' })).toBeInTheDocument();
    expect(screen.getByText(/Cross-project critical path across 2 projects/)).toBeInTheDocument();
    expect(screen.getByTestId('canvas-timeline')).toBeInTheDocument();
    expect(screen.getByText('Critical path')).toBeInTheDocument();
  });

  it('wraps the canvas in a scrollable container with a content-height spacer (issue 1624)', () => {
    useProgramSchedule.mockReturnValue(queryResult({ data: GOLDEN }));
    renderPage();
    // The container the engine scrolls must be overflow-auto, or the browser
    // never fires `scroll` and the virtualizing engine stays pinned at row 0.
    const scroll = screen.getByTestId('program-schedule-canvas-scroll');
    expect(scroll.className).toContain('overflow-auto');
    // Its spacer child must be sized to every lane row so scrollHeight exceeds
    // the viewport — this is the regression the bug was missing.
    const spacer = scroll.firstElementChild as HTMLElement;
    const rowCount = transformProgramSchedule(GOLDEN).tasks.length;
    expect(rowCount).toBeGreaterThan(0);
    expect(spacer.style.height).toBe(`${HEADER_HEIGHT + rowCount * ROW_HEIGHT}px`);
  });

  it('shows the empty state when there are no scheduled tasks', () => {
    useProgramSchedule.mockReturnValue(queryResult({ data: { ...GOLDEN, tasks: [] } }));
    renderPage();
    expect(screen.getByText('No program schedule yet')).toBeInTheDocument();
  });

  it('falls back to the empty state for a defensive 409 (endpoint emits 200-empty, not 409)', () => {
    useProgramSchedule.mockReturnValue(queryResult({ error: axiosError(409) }));
    renderPage();
    expect(screen.getByText('No program schedule yet')).toBeInTheDocument();
  });

  it('shows the too-large panel for a 422', () => {
    useProgramSchedule.mockReturnValue(queryResult({ error: axiosError(422) }));
    renderPage();
    expect(screen.getByText('This program is too large to chart live')).toBeInTheDocument();
  });

  it('shows the invalid-input panel naming the offending project for a structured 422 (#1981)', () => {
    useProgramSchedule.mockReturnValue(
      queryResult({
        error: axiosError(422, {
          code: 'program_schedule_invalid_input',
          detail: 'A task in “Migration Tooling” has data the schedule engine cannot compute.',
          reason: 'three-point estimates must satisfy optimistic <= most_likely <= pessimistic',
          project: { id: 'proj-mig', name: 'Migration Tooling' },
          task: { id: 't-bad', name: 'Something' },
        }),
      }),
    );
    renderPage();
    expect(screen.getByText("A project's task data can't be scheduled")).toBeInTheDocument();
    expect(
      screen.getByText(/A task in “Migration Tooling” has an invalid estimate or dependency/),
    ).toBeInTheDocument();
    // Routes to the offending project's schedule, not a dead retry.
    expect(
      screen.getByRole('button', { name: /Open Migration Tooling schedule/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('shows a forbidden message for a 403', () => {
    useProgramSchedule.mockReturnValue(queryResult({ error: axiosError(403) }));
    renderPage();
    expect(screen.getByRole('alert')).toHaveTextContent(/don.t have access/i);
  });

  it('shows a retryable error for a network/5xx failure', () => {
    useProgramSchedule.mockReturnValue(queryResult({ error: axiosError(500) }));
    renderPage();
    expect(screen.getByRole('alert')).toHaveTextContent(/Couldn.t load the program schedule/i);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
