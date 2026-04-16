import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { ProjectOverviewPage } from './ProjectOverviewPage';
import { apiClient } from '@/api/client';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@/hooks/useProjectId', () => ({
  useProjectId: () => 'proj-1',
}));

vi.mock('@/api/client', () => ({
  apiClient: { get: vi.fn() },
}));

const mockedGet = vi.mocked(apiClient.get);

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
  next_milestone: { name: 'Phase gate', date: '2026-05-01' },
  team_utilization_pct: 78,
};

const ATTENTION_RESPONSE = { items: [] };
const MY_TASKS_RESPONSE = { tasks: [] };

beforeEach(() => {
  mockedGet.mockImplementation((url: string) => {
    if ((url as string).endsWith('/overview/')) return Promise.resolve({ data: OVERVIEW_RESPONSE });
    if ((url as string).endsWith('/attention/')) return Promise.resolve({ data: ATTENTION_RESPONSE });
    if ((url as string).endsWith('/my-tasks/')) return Promise.resolve({ data: MY_TASKS_RESPONSE });
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

  it('renders all KPI card labels', () => {
    renderPage();
    expect(screen.getByText(/schedule health/i)).toBeInTheDocument();
    expect(screen.getByText(/^spi$/i)).toBeInTheDocument();
    expect(screen.getByText(/late tasks/i)).toBeInTheDocument();
    expect(screen.getByText(/critical tasks/i)).toBeInTheDocument();
    expect(screen.getByText(/next milestone/i)).toBeInTheDocument();
    expect(screen.getByText(/team utilization/i)).toBeInTheDocument();
  });

  it('shows KPI values after data loads', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('On track')).toBeInTheDocument();
    });
    expect(screen.getByText('0.97')).toBeInTheDocument();
    expect(screen.getByText('Phase gate')).toBeInTheDocument();
    expect(screen.getByText('78%')).toBeInTheDocument();
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

  it('renders attention items when present', async () => {
    mockedGet.mockImplementation((url: string) => {
      if ((url as string).endsWith('/overview/')) return Promise.resolve({ data: OVERVIEW_RESPONSE });
      if ((url as string).endsWith('/attention/'))
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
              },
            ],
          },
        });
      if ((url as string).endsWith('/my-tasks/')) return Promise.resolve({ data: MY_TASKS_RESPONSE });
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole('list', { name: /items needing attention/i })).toBeInTheDocument();
    });
  });

  it('renders my tasks when present', async () => {
    mockedGet.mockImplementation((url: string) => {
      if ((url as string).endsWith('/overview/')) return Promise.resolve({ data: OVERVIEW_RESPONSE });
      if ((url as string).endsWith('/attention/')) return Promise.resolve({ data: ATTENTION_RESPONSE });
      if ((url as string).endsWith('/my-tasks/'))
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
});
