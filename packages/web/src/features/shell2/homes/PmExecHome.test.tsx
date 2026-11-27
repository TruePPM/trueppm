import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { PmHome } from './PmHome';
import { ExecHome } from './ExecHome';

const h = vi.hoisted(() => ({
  programs: { data: undefined, isLoading: false, error: null, refetch: vi.fn() } as Record<
    string,
    unknown
  >,
  forecast: {} as Record<string, unknown>,
  projects: { data: [], isLoading: false, error: null, refetch: vi.fn() } as Record<
    string,
    unknown
  >,
  blocked: { data: undefined, error: null, refetch: vi.fn() } as Record<string, unknown>,
  decisions: { decisions: [], total: 0, isLoading: false, error: null, refetch: vi.fn() } as Record<
    string,
    unknown
  >,
}));
vi.mock('./ProgramShareStatus', () => ({
  ProgramShareStatus: () => <div data-testid="share-status" />,
}));
vi.mock('@/hooks/usePrograms', () => ({ usePrograms: () => h.programs }));
vi.mock('@/hooks/useProgramProjects', () => ({ useProgramProjects: () => h.projects }));
vi.mock('@/hooks/useProjectsHealthSummary', () => ({
  useProjectsHealthSummary: () => ({ data: [] }),
}));
vi.mock('@/hooks/useBlockedRollup', () => ({ useProjectBlocked: () => h.blocked }));
vi.mock('./useProgramForecast', () => ({ useProgramForecast: () => h.forecast }));
vi.mock('@/features/programs/decisions/useProgramDecisions', () => ({
  useProgramDecisions: () => h.decisions,
}));
vi.mock('@/features/charts', () => ({
  SCurveChart: () => <div data-testid="scurve" />,
  forecastToSCurveProps: () => ({}),
}));

const programs = [
  { id: 'a', name: 'Alpha', code: 'alpha' },
  { id: 'b', name: 'Beta', code: 'beta' },
];
const ready = {
  hero: {
    kind: 'ready',
    p80: '2026-12-07',
    asOf: null,
    definition: 'Server sentence.',
    driverProjectId: 'p1',
    projectsWithoutForecast: 0,
    projectsWithStaleForecast: 0,
    staleLine: null,
  },
  rollup: { refetch: vi.fn() },
  driverId: 'p1',
  mc: { data: { p80: '2026-12-07', p80DeltaVsCommitmentDays: 2 }, isLoading: false, error: null },
};

beforeEach(() => {
  h.programs = { data: programs, isLoading: false, error: null, refetch: vi.fn() };
  h.forecast = ready;
  h.projects = {
    data: [{ id: 'p1', name: 'Atlas' }],
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  };
  h.blocked = { data: { count: 0, blocked: [], truncated: false }, error: null, refetch: vi.fn() };
  h.decisions = { decisions: [], total: 0, isLoading: false, error: null, refetch: vi.fn() };
});

describe('PmHome', () => {
  it('loading and error states, never an empty home', () => {
    h.programs = { data: undefined, isLoading: true, error: null, refetch: vi.fn() };
    const { unmount } = renderWithRouter(<PmHome />);
    expect(screen.queryByText('No programs yet')).toBeNull();
    unmount();
    h.programs = { data: undefined, isLoading: false, error: new Error('x'), refetch: vi.fn() };
    renderWithRouter(<PmHome />);
    expect(screen.getByText("Couldn't load your programs.")).toBeInTheDocument();
  });

  it('empty state when the person has no programs', () => {
    h.programs = { data: [], isLoading: false, error: null, refetch: vi.fn() };
    renderWithRouter(<PmHome />);
    expect(screen.getByText('No programs yet')).toBeInTheDocument();
  });

  it('renders the forecast hero, focus cards and the project table from server facts', () => {
    h.blocked = {
      data: { count: 2, blocked: [{ title: 'Waiting on vendor' }], truncated: false },
      error: null,
      refetch: vi.fn(),
    };
    renderWithRouter(<PmHome />);
    expect(screen.getByRole('heading', { name: /Forecast · Alpha/ })).toBeInTheDocument();
    expect(screen.getByTestId('scurve')).toBeInTheDocument();
    expect(screen.getAllByText('2d past commitment').length).toBeGreaterThan(0);
    expect(screen.getByText('P80 is 2 working days past commitment.')).toBeInTheDocument();
    expect(screen.getByText('2 blocked in Atlas')).toBeInTheDocument();
    expect(screen.getByText('Longest waiting: Waiting on vendor')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Projects in this program' })).toBeInTheDocument();
    expect(screen.getByText('Nothing is waiting on a decision.')).toBeInTheDocument();
  });

  it('says the program P80 rests on a stale forecast (#2408)', () => {
    h.forecast = {
      ...ready,
      hero: {
        ...ready.hero,
        projectsWithStaleForecast: 1,
        staleLine: '1 forecast is out of date.',
      },
    };
    renderWithRouter(<PmHome />);
    expect(screen.getByText('1 forecast is out of date.')).toBeInTheDocument();
  });

  it('shows the rollup reason instead of a date when the program has no forecast', () => {
    h.forecast = {
      ...ready,
      hero: { kind: 'none', reason: 'No project has a forecast yet' },
      driverId: undefined,
      mc: { data: undefined, isLoading: false, error: null },
    };
    renderWithRouter(<PmHome />);
    expect(screen.getByText('No project has a forecast yet')).toBeInTheDocument();
    expect(screen.queryByTestId('scurve')).toBeNull();
  });

  it('switches program in the view only', () => {
    renderWithRouter(<PmHome />);
    fireEvent.change(screen.getByLabelText('Program'), { target: { value: 'b' } });
    expect(screen.getByRole('heading', { name: /Forecast · Beta/ })).toBeInTheDocument();
  });
});

describe('ExecHome', () => {
  it('opens on the server-chosen program and switches it without storing anything', () => {
    renderWithRouter(<ExecHome initialProgramId="a" />);
    expect(screen.getByRole('heading', { name: /Forecast · Alpha/ })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Program'), { target: { value: 'b' } });
    expect(screen.getByRole('heading', { name: /Forecast · Beta/ })).toBeInTheDocument();
  });

  it('opens on the switcher empty state when the server chose no program', () => {
    renderWithRouter(<ExecHome initialProgramId={null} />);
    expect(screen.getByRole('heading', { name: 'Choose a program' })).toBeInTheDocument();
    expect(screen.queryByTestId('scurve')).toBeNull();
  });

  it('says so when the viewer can see no programs, and errors with retry', () => {
    h.programs = { data: [], isLoading: false, error: null, refetch: vi.fn() };
    const { unmount } = renderWithRouter(<ExecHome initialProgramId={null} />);
    expect(screen.getByRole('heading', { name: 'No programs to show' })).toBeInTheDocument();
    unmount();
    h.programs = { data: undefined, isLoading: false, error: new Error('x'), refetch: vi.fn() };
    renderWithRouter(<ExecHome initialProgramId="a" />);
    expect(screen.getByText("Couldn't load your programs.")).toBeInTheDocument();
  });

  it('lists awaiting decisions and has no cross-program rollup', () => {
    h.decisions = {
      decisions: [
        { id: 'd1', title: 'Approve sandbox', owner_detail: null, due_date: '2026-12-01' },
      ],
      total: 1,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    };
    renderWithRouter(<ExecHome initialProgramId="a" />);
    expect(screen.getByText('Approve sandbox')).toBeInTheDocument();
    expect(screen.queryByText(/all programs/i)).toBeNull();
  });
});
