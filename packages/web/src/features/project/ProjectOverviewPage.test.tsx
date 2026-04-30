import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router';
import { ProjectOverviewPage, CriticalPathPanel } from './ProjectOverviewPage';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@/hooks/useProjectId', () => ({
  useProjectId: () => 'proj-1',
}));

const mockedGet = vi.fn();
const mockedPost = vi.fn();

vi.mock('@/api/client', () => ({
  apiClient: {
    get: (...args: unknown[]) => mockedGet(...args) as unknown,
    post: (...args: unknown[]) => mockedPost(...args) as unknown,
  },
}));

// ---------------------------------------------------------------------------
// Render helper
// ---------------------------------------------------------------------------

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [{ path: '/projects/:projectId/overview', element: <ProjectOverviewPage /> }],
    { initialEntries: ['/projects/proj-1/overview'] },
  );
  return render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const OVERVIEW_RESPONSE = {
  schedule_health: 'on_track',
  spi: 0.97,
  tasks_late_count: 1,
  critical_task_count: 3,
  total_tasks: 20,
  complete_tasks: 10,
  next_milestone: { id: 'm1', name: 'Phase gate', date: '2026-05-01', percent_complete: 0 },
  team_utilization_pct: 78,
  owner_name: 'Alice Smith',
  start_date: '2026-01-01',
  open_risk_count: 4,
  high_risk_count: 1,
};

const ATTENTION_RESPONSE = { items: [] };
const MY_TASKS_RESPONSE = { tasks: [] };
const CP_TASKS_RESPONSE = { count: 0, next: null, previous: null, results: [] };

beforeEach(() => {
  mockedGet.mockImplementation((url: string) => {
    if (url.endsWith('/overview/')) return Promise.resolve({ data: OVERVIEW_RESPONSE });
    if (url.endsWith('/attention/')) return Promise.resolve({ data: ATTENTION_RESPONSE });
    if (url.endsWith('/my-tasks/')) return Promise.resolve({ data: MY_TASKS_RESPONSE });
    if (url === '/tasks/') return Promise.resolve({ data: CP_TASKS_RESPONSE });
    if (url.endsWith('/monte-carlo/latest/')) return Promise.reject(new Error('404'));
    return Promise.reject(new Error(`Unexpected URL: ${url}`));
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProjectOverviewPage', () => {
  it('renders KPIs section with landmark role', () => {
    renderPage();
    expect(screen.getByRole('region', { name: /project kpis/i })).toBeInTheDocument();
  });

  it('renders burn-up placeholder', () => {
    renderPage();
    expect(screen.getByRole('img', { name: /burn-up chart/i })).toBeInTheDocument();
  });

  it('renders attention section', () => {
    renderPage();
    expect(screen.getByRole('region', { name: /attention items/i })).toBeInTheDocument();
  });

  it('renders my-tasks section', () => {
    renderPage();
    expect(screen.getByRole('region', { name: /my tasks this week/i })).toBeInTheDocument();
  });

  it('renders MC forecast section', () => {
    renderPage();
    expect(screen.getByRole('region', { name: /monte carlo forecast/i })).toBeInTheDocument();
  });

  it('renders six KPI card labels', async () => {
    renderPage();
    expect(await screen.findByText(/schedule health/i)).toBeInTheDocument();
    expect(screen.getByText(/forecast finish/i)).toBeInTheDocument();
    expect(screen.getByText(/tasks late/i)).toBeInTheDocument();
    expect(screen.getByText(/next milestone/i)).toBeInTheDocument();
    expect(screen.getByText(/team utilization/i)).toBeInTheDocument();
    expect(screen.getByText(/open risks/i)).toBeInTheDocument();
  });

  it('shows KPI values after data loads', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getAllByText('On track').length).toBeGreaterThan(0);
    });
    expect(screen.getByText('Phase gate')).toBeInTheDocument();
    expect(screen.getByText('78%')).toBeInTheDocument();
  });

  it('shows SPI sub-label on schedule health card', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/SPI 0\.97/)).toBeInTheDocument();
    });
  });

  it('renders project header with health badge', async () => {
    renderPage();
    await waitFor(() => {
      // Health badge appears in the header
      expect(screen.getAllByText('On track').length).toBeGreaterThan(0);
    });
  });

  it('shows owner name in header subtitle', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/Owner: Alice Smith/)).toBeInTheDocument();
    });
  });

  it('shows all-clear attention message when items list is empty', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/no items need attention/i)).toBeInTheDocument();
    });
  });

  it('shows "no tasks" message when my-tasks is empty', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/no tasks assigned/i)).toBeInTheDocument();
    });
  });

  it('shows Run forecast CTA when no MC result', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /run forecast/i })).toBeInTheDocument();
    });
  });

  it('shows P50/P80/P95 pills when MC result available', async () => {
    const mcResult = {
      p50: '2026-06-01',
      p80: '2026-06-15',
      p95: '2026-06-30',
      runs: 1000,
      distribution: [],
      histogram_buckets: [],
    };
    mockedGet.mockImplementation((url: string) => {
      if (url.endsWith('/overview/')) return Promise.resolve({ data: OVERVIEW_RESPONSE });
      if (url.endsWith('/attention/')) return Promise.resolve({ data: ATTENTION_RESPONSE });
      if (url.endsWith('/my-tasks/')) return Promise.resolve({ data: MY_TASKS_RESPONSE });
      if (url === '/tasks/') return Promise.resolve({ data: CP_TASKS_RESPONSE });
      if (url.endsWith('/monte-carlo/latest/')) return Promise.resolve({ data: mcResult });
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/8 in 10 simulations finish by/i)).toBeInTheDocument();
    });
  });

  it('renders attention items when present', async () => {
    mockedGet.mockImplementation((url: string) => {
      if (url.endsWith('/overview/')) return Promise.resolve({ data: OVERVIEW_RESPONSE });
      if (url.endsWith('/attention/'))
        return Promise.resolve({
          data: {
            items: [
              {
                severity: 'critical',
                type: 'critical_task_late',
                task_id: 't1',
                task_name: 'Foundation work',
                message: 'Foundation work is late and on the critical path.',
                assignee_name: null,
                date: '2026-04-10',
                detail: 'On critical path',
                link_target: null,
              },
            ],
          },
        });
      if (url.endsWith('/my-tasks/')) return Promise.resolve({ data: MY_TASKS_RESPONSE });
      if (url.endsWith('/monte-carlo/latest/')) return Promise.reject(new Error('404'));
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole('list', { name: /items needing attention/i })).toBeInTheDocument();
    });
  });

  it('renders my tasks when present', async () => {
    mockedGet.mockImplementation((url: string) => {
      if (url.endsWith('/overview/')) return Promise.resolve({ data: OVERVIEW_RESPONSE });
      if (url.endsWith('/attention/')) return Promise.resolve({ data: ATTENTION_RESPONSE });
      if (url === '/tasks/') return Promise.resolve({ data: CP_TASKS_RESPONSE });
      if (url.endsWith('/monte-carlo/latest/')) return Promise.reject(new Error('404'));
      if (url.endsWith('/my-tasks/'))
        return Promise.resolve({
          data: {
            tasks: [
              {
                id: 't1',
                name: 'Write specs',
                due: '2026-04-18',
                due_date: '2026-04-18',
                status: 'IN_PROGRESS',
                percent_complete: 40,
                is_critical: false,
              },
            ],
          },
        });
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole('list', { name: /my tasks due this week/i })).toBeInTheDocument();
      expect(screen.getByText('Write specs')).toBeInTheDocument();
    });
  });

  it('renders critical path section', () => {
    renderPage();
    expect(screen.getByRole('region', { name: /critical path/i })).toBeInTheDocument();
  });

  it('shows empty message when no CP tasks', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/no critical path tasks found/i)).toBeInTheDocument();
    });
  });

  it('renders CP tasks when present', async () => {
    mockedGet.mockImplementation((url: string) => {
      if (url.endsWith('/overview/')) return Promise.resolve({ data: OVERVIEW_RESPONSE });
      if (url.endsWith('/attention/')) return Promise.resolve({ data: ATTENTION_RESPONSE });
      if (url.endsWith('/my-tasks/')) return Promise.resolve({ data: MY_TASKS_RESPONSE });
      if (url.endsWith('/monte-carlo/latest/')) return Promise.reject(new Error('404'));
      if (url === '/tasks/')
        return Promise.resolve({
          data: {
            count: 2,
            next: null,
            previous: null,
            results: [
              { id: 'cp1', name: 'Foundation work', duration: 10, total_float: -2 },
              { id: 'cp2', name: 'Steel erection', duration: 5, total_float: 0 },
            ],
          },
        });
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole('list', { name: /critical path tasks/i })).toBeInTheDocument();
      expect(screen.getByText('Foundation work')).toBeInTheDocument();
      expect(screen.getByText('Steel erection')).toBeInTheDocument();
    });
  });

  it('shows "show full critical path" link pointing to schedule', async () => {
    mockedGet.mockImplementation((url: string) => {
      if (url.endsWith('/overview/')) return Promise.resolve({ data: OVERVIEW_RESPONSE });
      if (url.endsWith('/attention/')) return Promise.resolve({ data: ATTENTION_RESPONSE });
      if (url.endsWith('/my-tasks/')) return Promise.resolve({ data: MY_TASKS_RESPONSE });
      if (url.endsWith('/monte-carlo/latest/')) return Promise.reject(new Error('404'));
      if (url === '/tasks/')
        return Promise.resolve({
          data: {
            count: 1,
            next: null,
            previous: null,
            results: [{ id: 'cp1', name: 'Design sprint', duration: 7, total_float: 0 }],
          },
        });
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });
    renderPage();
    await waitFor(() => {
      const link = screen.getByRole('link', { name: /show full critical path/i });
      expect(link).toBeInTheDocument();
      expect(link).toHaveAttribute('href', '/projects/proj-1/schedule');
    });
  });
});

// ---------------------------------------------------------------------------
// CriticalPathPanel unit tests
// ---------------------------------------------------------------------------

describe('CriticalPathPanel', () => {
  function renderPanel(tasks: Parameters<typeof CriticalPathPanel>[0]['tasks'], projectId = 'proj-1') {
    return render(
      <MemoryRouter>
        <CriticalPathPanel tasks={tasks} projectId={projectId} />
      </MemoryRouter>,
    );
  }

  it('shows empty state when tasks array is empty', () => {
    renderPanel([]);
    expect(screen.getByText(/no critical path tasks found/i)).toBeInTheDocument();
  });

  it('renders up to 5 tasks', () => {
    const tasks = Array.from({ length: 7 }, (_, i) => ({
      id: `t${i}`,
      name: `Task ${i}`,
      duration: 3,
      total_float: i,
    }));
    renderPanel(tasks);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(5);
  });

  it('shows remaining count when more than 5 tasks', () => {
    const tasks = Array.from({ length: 8 }, (_, i) => ({
      id: `t${i}`,
      name: `Task ${i}`,
      duration: 3,
      total_float: i,
    }));
    renderPanel(tasks);
    expect(screen.getByText('+3 more critical tasks')).toBeInTheDocument();
  });

  it('shows singular "task" when 1 remaining', () => {
    const tasks = Array.from({ length: 6 }, (_, i) => ({
      id: `t${i}`,
      name: `Task ${i}`,
      duration: 3,
      total_float: i,
    }));
    renderPanel(tasks);
    expect(screen.getByText('+1 more critical task')).toBeInTheDocument();
  });

  it('shows total slack in the task row', () => {
    renderPanel([{ id: 't1', name: 'Foundation', duration: 10, total_float: -3 }]);
    expect(screen.getByText(/total slack: -3d/i)).toBeInTheDocument();
  });

  it('shows dash for total slack when null', () => {
    renderPanel([{ id: 't1', name: 'Foundation', duration: 10, total_float: null }]);
    expect(screen.getByText(/total slack: —/i)).toBeInTheDocument();
  });

  it('link points to the schedule view for the project', () => {
    renderPanel([{ id: 't1', name: 'Foundation', duration: 10, total_float: 0 }], 'proj-42');
    expect(screen.getByRole('link', { name: /show full critical path/i })).toHaveAttribute(
      'href',
      '/projects/proj-42/schedule',
    );
  });
});
