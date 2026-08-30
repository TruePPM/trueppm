import { screen, waitFor, fireEvent, within } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, MemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { ProjectOverviewPage, CriticalPathPanel } from './ProjectOverviewPage';
import { DRAFT_EXCLUSION_SENTENCE } from './draftExclusion';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mutable so a test can exercise the pre-route "no project id yet" render, where
// every query is disabled and the KPI cards must fall back to a static,
// non-clickable placeholder set.
const projectIdRef = vi.hoisted(() => ({ current: 'proj-1' as string | undefined }));

vi.mock('@/hooks/useProjectId', () => ({
  useProjectId: () => projectIdRef.current,
}));

const mockedGet = vi.fn();
const mockedPost = vi.fn();
const mockedPatch = vi.fn();

vi.mock('@/api/client', () => ({
  apiClient: {
    get: (...args: unknown[]) => mockedGet(...args) as unknown,
    post: (...args: unknown[]) => mockedPost(...args) as unknown,
    patch: (...args: unknown[]) => mockedPatch(...args) as unknown,
  },
}));

// ---------------------------------------------------------------------------
// Render helper
// ---------------------------------------------------------------------------

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      { path: '/projects/:projectId/overview', element: <ProjectOverviewPage /> },
      // Stub destinations so the first-run CTAs' router pushes (#2048) can be
      // asserted by the landed route rather than an href (they are Buttons, not
      // Links — the DS primary recipe requires <Button>).
      { path: '/projects/:projectId/schedule', element: <div>schedule-route</div> },
      { path: '/projects/:projectId/board', element: <div>board-route</div> },
      { path: '/projects/:projectId/settings', element: <div>settings-route</div> },
    ],
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
  // Added-time facts (#2483). The default fixture is a measured premium so the
  // focus row's first card renders its full anatomy in the common case.
  risk_premium_state: 'premium',
  risk_premium_days: 11,
  risk_premium_ratio: 0.09,
  risk_premium_band: null,
  risk_premium_as_of: '2026-07-27T09:12:00Z',
  risk_premium_reason: null,
  risk_premium_cpm_finish: '2026-10-24',
  risk_premium_p80: '2026-11-04',
};

const ATTENTION_RESPONSE = { items: [] };
const MY_TASKS_RESPONSE = { tasks: [] };
const CP_TASKS_RESPONSE = { count: 0, next: null, previous: null, results: [] };
// Header hooks added in issue 1606: useProject (project detail) + useCurrentUserRole
// (self membership row). Default to a manual health of AUTO (no reported chip) and a
// non-Admin role so the common assertions are unaffected; individual tests override.
const PROJECT_DETAIL = { id: 'proj-1', server_version: 1, name: 'Proj', health: 'AUTO' };
const SELF_MEMBERSHIP_MEMBER = [{ id: 'me', role: 100 }];

/** Resolve the two header-hook endpoints; return null for anything else. */
function headerHookResponse(url: string): { data: unknown } | null {
  if (url === '/projects/proj-1/') return { data: PROJECT_DETAIL };
  if (url.endsWith('/members/')) return { data: SELF_MEMBERSHIP_MEMBER };
  return null;
}

beforeEach(() => {
  projectIdRef.current = 'proj-1';
  mockedPatch.mockReset();
  mockedPost.mockReset();
  mockedPost.mockResolvedValue({ data: {} });
  mockedGet.mockImplementation((url: string) => {
    const header = headerHookResponse(url);
    if (header) return Promise.resolve(header);
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
  it('renders the focus + secondary KPI sections as landmarks', async () => {
    renderPage();
    // Default fixture has at-risk metrics (1 late, 1 high risk) → the focus heading
    // reads "Needs attention" (#1191). Every metric demoted to the secondary strip
    // is neutral or on-track, so its heading reads "Holding steady" (#2429) — the
    // strip is named by its severity verdict, not by the residual "More metrics".
    expect(await screen.findByRole('region', { name: /needs attention/i })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /holding steady/i })).toBeInTheDocument();
  });

  it('renders burn-up chart section', () => {
    renderPage();
    expect(screen.getByRole('region', { name: /burn-up chart/i })).toBeInTheDocument();
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

  it('renders the added-time card plus all five KPI labels across the two tiers', async () => {
    renderPage();
    expect(await screen.findByText(/schedule health/i)).toBeInTheDocument();
    // Added time replaced the bare "Forecast finish" P80 card in #2483 — it renders
    // the same commitment date *with* the computed finish it departs from, so
    // keeping both would have put P80 on this row twice (rule 284).
    expect(
      screen.getByRole('region', { name: /added time vs computed finish/i }),
    ).toBeInTheDocument();
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

  // #1764: a failed fetch on Overview used to hang on the KPI skeleton (health
  // row) or render empty (lower sections) — indistinguishable from loading /
  // "nothing here yet". Each surface now shows a retry banner instead.
  it('shows a retry banner (not a perpetual skeleton) when the health fetch fails', async () => {
    mockedGet.mockImplementation((url: string) => {
      const header = headerHookResponse(url);
      if (header) return Promise.resolve(header);
      if (url.endsWith('/overview/')) return Promise.reject(new Error('500'));
      if (url.endsWith('/attention/')) return Promise.resolve({ data: ATTENTION_RESPONSE });
      if (url.endsWith('/my-tasks/')) return Promise.resolve({ data: MY_TASKS_RESPONSE });
      if (url === '/tasks/') return Promise.resolve({ data: CP_TASKS_RESPONSE });
      if (url.endsWith('/monte-carlo/latest/')) return Promise.reject(new Error('404'));
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });
    renderPage();
    const health = await screen.findByRole('region', { name: /project health/i });
    await waitFor(() => {
      // Inline (widget-level) errors announce politely via role="status".
      expect(within(health).getByRole('status')).toHaveTextContent(
        /Couldn't load project health\./,
      );
    });
    expect(within(health).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('shows a retry banner in the attention section when its fetch fails', async () => {
    mockedGet.mockImplementation((url: string) => {
      const header = headerHookResponse(url);
      if (header) return Promise.resolve(header);
      if (url.endsWith('/overview/')) return Promise.resolve({ data: OVERVIEW_RESPONSE });
      if (url.endsWith('/attention/')) return Promise.reject(new Error('500'));
      if (url.endsWith('/my-tasks/')) return Promise.resolve({ data: MY_TASKS_RESPONSE });
      if (url === '/tasks/') return Promise.resolve({ data: CP_TASKS_RESPONSE });
      if (url.endsWith('/monte-carlo/latest/')) return Promise.reject(new Error('404'));
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });
    renderPage();
    const attention = await screen.findByRole('region', { name: /attention items/i });
    await waitFor(() => {
      expect(within(attention).getByRole('status')).toHaveTextContent(
        /Couldn't load attention items\./,
      );
    });
  });

  it('renders plain-language leads, not EVM jargon (#1192)', async () => {
    renderPage();
    // Schedule health leads with its band word + a plain "On schedule" subtitle…
    expect(await screen.findByText('On schedule')).toBeInTheDocument();
    // …tasks-late reads "N late" / "of M tasks", risks read "N high" / "N in register".
    expect(screen.getByText('1 late')).toBeInTheDocument();
    expect(screen.getByText('of 20 tasks')).toBeInTheDocument();
    expect(screen.getByText('1 high')).toBeInTheDocument();
    expect(screen.getByText('4 in register')).toBeInTheDocument();
    // …and added time names both endpoints in role terms, not percentile jargon
    // alone: "Computed finish" and "P80 commit", never a bare "P80 finish estimate".
    expect(screen.getByText('Computed finish')).toBeInTheDocument();
    expect(screen.getByText('P80 commit')).toBeInTheDocument();
  });

  it('strips SPI/EVM/CPI/WBS jargon from all rendered labels and subtitles (#1192)', async () => {
    const { container } = renderPage();
    await screen.findByText('On schedule');
    // SPI lives only in the schedule card's title attribute, never in visible text.
    expect(container.textContent).not.toMatch(/\bSPI\b/);
    expect(container.textContent).not.toMatch(/\bEVM\b/);
    expect(container.textContent).not.toMatch(/\bCPI\b/);
    expect(container.textContent).not.toMatch(/\bWBS\b/);
    // The raw SPI is still available as an explanatory title for the curious PM.
    const scheduleTitle = container.querySelector('[title*="Schedule Performance Index"]');
    expect(scheduleTitle).not.toBeNull();
  });

  // #506: long milestone names clipped at narrow card widths. The fix uses
  // container-query fluid type (`cqi`), `break-words`, and `min-w-0 overflow-hidden`
  // so the value element stays inside the card and wraps rather than overflowing.
  it('KpiCard value uses fluid container-query type and wraps long text (#506)', async () => {
    mockedGet.mockImplementation((url: string) => {
      if (url.endsWith('/overview/')) {
        return Promise.resolve({
          data: {
            ...OVERVIEW_RESPONSE,
            next_milestone: {
              id: 'm1',
              name: 'Production Launch Phase 2',
              date: '2026-05-01',
              percent_complete: 0,
            },
          },
        });
      }
      if (url.endsWith('/attention/')) return Promise.resolve({ data: ATTENTION_RESPONSE });
      if (url.endsWith('/my-tasks/')) return Promise.resolve({ data: MY_TASKS_RESPONSE });
      if (url === '/tasks/') return Promise.resolve({ data: CP_TASKS_RESPONSE });
      if (url.endsWith('/monte-carlo/latest/')) return Promise.reject(new Error('404'));
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });
    renderPage();
    const valueEl = await screen.findByText('Production Launch Phase 2');
    expect(valueEl.className).toMatch(/break-words/);
    expect(valueEl.className).toMatch(/leading-tight/);
    expect(valueEl.className).toMatch(/text-\[clamp\(0\.875rem,7cqi,1\.5rem\)\]/);

    // The card container must allow shrinking + clipping for the fluid type to work
    const card = valueEl.parentElement;
    expect(card?.className).toMatch(/min-w-0/);
    expect(card?.className).toMatch(/overflow-hidden/);
    expect(card?.className).toMatch(/\[container-type:inline-size\]/);
  });

  it('renders project header with health badge', async () => {
    renderPage();
    await waitFor(() => {
      // Health badge appears in the header
      expect(screen.getAllByText('On track').length).toBeGreaterThan(0);
    });
  });

  // issue 1606 — the "Update Status" header button was a dead disabled control;
  // it now opens the reported-health dialog.
  it('renders an enabled Update Status button (no longer a dead control)', async () => {
    renderPage();
    const btn = await screen.findByRole('button', { name: /update status/i });
    expect(btn).toBeEnabled();
  });

  it('opens the Update project status dialog on click', async () => {
    renderPage();
    const btn = await screen.findByRole('button', { name: /update status/i });
    fireEvent.click(btn);
    const dialog = await screen.findByRole('dialog', { name: /update project status/i });
    expect(dialog).toBeInTheDocument();
    // Default membership is Member (role 100 < ADMIN), so the dialog opens
    // read-only: the status value + provenance, not the editable status buttons.
    expect(within(dialog).queryByRole('button', { name: 'At risk' })).toBeNull();
    expect(
      within(dialog).getByLabelText(
        'Reported status: Auto, set by the Project Manager. View only.',
      ),
    ).toBeInTheDocument();
  });

  it('shows a "Reported" chip only when the manual health is non-AUTO', async () => {
    mockedGet.mockImplementation((url: string) => {
      if (url === '/projects/proj-1/')
        return Promise.resolve({ data: { ...PROJECT_DETAIL, health: 'AT_RISK' } });
      if (url.endsWith('/members/')) return Promise.resolve({ data: SELF_MEMBERSHIP_MEMBER });
      if (url.endsWith('/overview/')) return Promise.resolve({ data: OVERVIEW_RESPONSE });
      if (url.endsWith('/attention/')) return Promise.resolve({ data: ATTENTION_RESPONSE });
      if (url.endsWith('/my-tasks/')) return Promise.resolve({ data: MY_TASKS_RESPONSE });
      if (url === '/tasks/') return Promise.resolve({ data: CP_TASKS_RESPONSE });
      if (url.endsWith('/monte-carlo/latest/')) return Promise.reject(new Error('404'));
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });
    renderPage();
    await waitFor(() => {
      expect(screen.getByLabelText(/Reported project health: At risk/i)).toBeInTheDocument();
    });
  });

  it('does not show a "Reported" chip when the manual health is AUTO', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getAllByText('On track').length).toBeGreaterThan(0);
    });
    expect(screen.queryByLabelText(/Reported project health/i)).toBeNull();
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
      project_id: 'proj-1',
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

  it('shows the Rerun forecast button when a result is cached (issue #335 regression guard)', async () => {
    // Pre-#335: the Rerun button only appeared in the empty state. Once a
    // result was cached, users had no in-product way to refresh after editing
    // task durations — they had to wait 24h for the cache to expire.
    const mcResult = {
      project_id: 'proj-1',
      p50: '2026-06-01',
      p80: '2026-06-15',
      p95: '2026-06-30',
      runs: 1000,
      distribution: [],
      histogram_buckets: [],
      last_run_at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
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
      expect(screen.getByRole('button', { name: /rerun forecast/i })).toBeInTheDocument();
    });
    // Last-run freshness signal is visible alongside the chips
    expect(screen.getByText(/last run/i)).toBeInTheDocument();
    expect(screen.getByText(/2h ago/)).toBeInTheDocument();
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
    // The attention row links to the task's full-page detail view (#1984).
    const link = screen.getByRole('link', { name: /Foundation work.*View task/i });
    expect(link).toHaveAttribute('href', '/projects/proj-1/tasks/t1');
  });

  it('renders an attention item with no task_id as a non-interactive read', async () => {
    mockedGet.mockImplementation((url: string) => {
      if (url.endsWith('/overview/')) return Promise.resolve({ data: OVERVIEW_RESPONSE });
      if (url.endsWith('/attention/'))
        return Promise.resolve({
          data: {
            items: [
              {
                severity: 'warning',
                type: 'overallocation',
                task_id: null,
                task_name: 'Team overallocated',
                assignee_name: null,
                date: null,
                detail: 'Resource over capacity',
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
      expect(screen.getByText('Team overallocated')).toBeInTheDocument();
    });
    // A null task_id item has no task to navigate to, so it stays a static read.
    expect(screen.queryByRole('link', { name: /Team overallocated/i })).not.toBeInTheDocument();
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
    // The my-task row links to the task's full-page detail view (#1984).
    const link = screen.getByRole('link', { name: /Write specs.*View task/i });
    expect(link).toHaveAttribute('href', '/projects/proj-1/tasks/t1');
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
// KPI card drill-downs (#1691)
// ---------------------------------------------------------------------------

describe('KPI card drill-downs', () => {
  function setupRole(role: number, overview: Record<string, unknown> = OVERVIEW_RESPONSE) {
    mockedGet.mockImplementation((url: string) => {
      if (url === '/projects/proj-1/') return Promise.resolve({ data: PROJECT_DETAIL });
      if (url.endsWith('/members/')) return Promise.resolve({ data: [{ id: 'me', role }] });
      if (url.endsWith('/overview/')) return Promise.resolve({ data: overview });
      if (url.endsWith('/attention/')) return Promise.resolve({ data: ATTENTION_RESPONSE });
      if (url.endsWith('/my-tasks/')) return Promise.resolve({ data: MY_TASKS_RESPONSE });
      if (url === '/tasks/') return Promise.resolve({ data: CP_TASKS_RESPONSE });
      if (url.endsWith('/monte-carlo/latest/')) return Promise.reject(new Error('404'));
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });
  }

  it('Tasks late (>0) links to the grid pre-filtered to overdue', async () => {
    setupRole(100);
    renderPage();
    const link = await screen.findByRole('link', { name: /view overdue tasks/i });
    expect(link).toHaveAttribute('href', '/projects/proj-1/grid?due=overdue');
  });

  it('Open risks (high>0) links to the risk register High segment', async () => {
    setupRole(100);
    renderPage();
    const link = await screen.findByRole('link', { name: /view the risk register/i });
    expect(link).toHaveAttribute('href', '/projects/proj-1/risk?severity=high');
  });

  it('Schedule health always links to the schedule view', async () => {
    setupRole(100);
    renderPage();
    const link = await screen.findByRole('link', { name: /schedule health.*view the schedule/i });
    expect(link).toHaveAttribute('href', '/projects/proj-1/schedule');
  });

  it('Next milestone links to the milestone task detail', async () => {
    setupRole(100);
    renderPage();
    const link = await screen.findByRole('link', { name: /next milestone.*view the milestone/i });
    expect(link).toHaveAttribute('href', '/projects/proj-1/tasks/m1');
  });

  it('Team utilization is a static read for a Member (no click into a 403)', async () => {
    setupRole(100);
    renderPage();
    const value = await screen.findByText('78%');
    expect(value.closest('a')).toBeNull();
  });

  it('Team utilization links to Resources for a Scheduler', async () => {
    setupRole(200);
    renderPage();
    const link = await screen.findByRole('link', {
      name: /team utilization.*view team allocation/i,
    });
    expect(link).toHaveAttribute('href', '/projects/proj-1/resources');
  });

  it('a real-zero Tasks late card is not interactive (rule 172)', async () => {
    setupRole(100, { ...OVERVIEW_RESPONSE, tasks_late_count: 0 });
    renderPage();
    const value = await screen.findByText('0 late');
    expect(value.closest('a')).toBeNull();
    expect(screen.queryByRole('link', { name: /view overdue tasks/i })).toBeNull();
  });

  it('an unsimulated project gets the not-run added-time card, not a zero', async () => {
    // The bare "Forecast finish" KPI this replaced showed an em dash for a project
    // with no run. Added time says which of the two blanks it is — never run at all,
    // versus run and found nothing — because the fixes differ (#2483).
    setupRole(100, { ...OVERVIEW_RESPONSE, risk_premium_state: 'not_run' });
    renderPage();
    await screen.findByText('On schedule');

    expect(screen.getByText('Not run yet')).toBeInTheDocument();
    expect(screen.queryByText(/^\+?0d$/)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CriticalPathPanel unit tests
// ---------------------------------------------------------------------------

describe('CriticalPathPanel', () => {
  function renderPanel(
    tasks: Parameters<typeof CriticalPathPanel>[0]['tasks'],
    projectId = 'proj-1',
  ) {
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

  it('each task row links to that task detail view (#1984)', () => {
    renderPanel([{ id: 'cp1', name: 'Foundation', duration: 10, total_float: -3 }], 'proj-42');
    const row = screen.getByRole('link', { name: /Foundation.*View task/i });
    expect(row).toHaveAttribute('href', '/projects/proj-42/tasks/cp1');
  });
});

// ---------------------------------------------------------------------------
// Branch coverage — open risks KPI card, status pills, severity dots, MC histogram
// ---------------------------------------------------------------------------

describe('Open risks KPI card branches', () => {
  it('shows "{n} high" when high_risk_count > 0', async () => {
    mockedGet.mockImplementation((url: string) => {
      if (url.endsWith('/overview/'))
        return Promise.resolve({
          data: { ...OVERVIEW_RESPONSE, open_risk_count: 5, high_risk_count: 2 },
        });
      if (url.endsWith('/attention/')) return Promise.resolve({ data: ATTENTION_RESPONSE });
      if (url.endsWith('/my-tasks/')) return Promise.resolve({ data: MY_TASKS_RESPONSE });
      if (url === '/tasks/') return Promise.resolve({ data: CP_TASKS_RESPONSE });
      if (url.endsWith('/monte-carlo/latest/')) return Promise.reject(new Error('404'));
      return Promise.reject(new Error(url));
    });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('2 high')).toBeInTheDocument();
      expect(screen.getByText('5 in register')).toBeInTheDocument();
    });
  });

  it('shows total open count when high_risk_count is 0', async () => {
    mockedGet.mockImplementation((url: string) => {
      if (url.endsWith('/overview/'))
        return Promise.resolve({
          data: { ...OVERVIEW_RESPONSE, open_risk_count: 3, high_risk_count: 0 },
        });
      if (url.endsWith('/attention/')) return Promise.resolve({ data: ATTENTION_RESPONSE });
      if (url.endsWith('/my-tasks/')) return Promise.resolve({ data: MY_TASKS_RESPONSE });
      if (url === '/tasks/') return Promise.resolve({ data: CP_TASKS_RESPONSE });
      if (url.endsWith('/monte-carlo/latest/')) return Promise.reject(new Error('404'));
      return Promise.reject(new Error(url));
    });
    renderPage();
    await waitFor(() => {
      // Open risks card label + value "3 open" + register subtitle.
      expect(screen.getByText(/^Open risks$/)).toBeInTheDocument();
      expect(screen.getByText('3 open')).toBeInTheDocument();
      expect(screen.getByText('3 in register')).toBeInTheDocument();
    });
  });

  it('shows em-dash when both risk counts are absent', async () => {
    mockedGet.mockImplementation((url: string) => {
      if (url.endsWith('/overview/')) {
        const data: Record<string, unknown> = { ...OVERVIEW_RESPONSE };
        delete data.open_risk_count;
        delete data.high_risk_count;
        return Promise.resolve({ data });
      }
      if (url.endsWith('/attention/')) return Promise.resolve({ data: ATTENTION_RESPONSE });
      if (url.endsWith('/my-tasks/')) return Promise.resolve({ data: MY_TASKS_RESPONSE });
      if (url === '/tasks/') return Promise.resolve({ data: CP_TASKS_RESPONSE });
      if (url.endsWith('/monte-carlo/latest/')) return Promise.reject(new Error('404'));
      return Promise.reject(new Error(url));
    });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/^Open risks$/)).toBeInTheDocument();
    });
  });
});

describe('My tasks status pill + owner branches', () => {
  function makeTask(overrides: Record<string, unknown>) {
    return {
      id: 't',
      name: 'T',
      due: '2026-04-18',
      due_date: '2026-04-18',
      status: 'IN_PROGRESS',
      percent_complete: 0,
      is_critical: false,
      ...overrides,
    };
  }

  function setup(tasks: unknown[]) {
    mockedGet.mockImplementation((url: string) => {
      if (url.endsWith('/overview/')) return Promise.resolve({ data: OVERVIEW_RESPONSE });
      if (url.endsWith('/attention/')) return Promise.resolve({ data: ATTENTION_RESPONSE });
      if (url.endsWith('/my-tasks/')) return Promise.resolve({ data: { tasks } });
      if (url === '/tasks/') return Promise.resolve({ data: CP_TASKS_RESPONSE });
      if (url.endsWith('/monte-carlo/latest/')) return Promise.reject(new Error('404'));
      return Promise.reject(new Error(url));
    });
  }

  it.each([
    ['COMPLETE', 'Done'],
    ['IN_PROGRESS', 'In progress'],
    ['REVIEW', 'Review'],
    ['NOT_STARTED', 'Not started'],
    ['BACKLOG', 'Backlog'],
    ['ON_HOLD', 'On hold'],
  ])('renders the %s status pill as "%s"', async (status, label) => {
    setup([makeTask({ id: status, name: `Task-${status}`, status })]);
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(label)).toBeInTheDocument();
    });
  });

  it('renders no pill when status is unknown', async () => {
    setup([makeTask({ id: 'x', name: 'Mystery', status: 'UNKNOWN_STATUS' })]);
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Mystery')).toBeInTheDocument();
    });
    expect(screen.queryByText(/Done|In progress|Review|Not started|Backlog|On hold/)).toBeNull();
  });

  it('renders owner initials and name when present', async () => {
    setup([
      makeTask({
        id: 'o',
        name: 'Owned task',
        owner_name: 'Bob Jones',
        owner_initials: 'BJ',
      }),
    ]);
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('BJ')).toBeInTheDocument();
      expect(screen.getByLabelText(/Owner: Bob Jones/)).toBeInTheDocument();
    });
  });

  it('falls back to "?" / Unassigned when owner data is absent', async () => {
    setup([makeTask({ id: 'u', name: 'No owner' })]);
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('?')).toBeInTheDocument();
      expect(screen.getByLabelText(/Owner: Unassigned/)).toBeInTheDocument();
    });
  });

  it('renders CP badge when is_critical is true', async () => {
    setup([makeTask({ id: 'c', name: 'Crit', is_critical: true })]);
    renderPage();
    await waitFor(() => {
      expect(screen.getByLabelText('Critical path')).toBeInTheDocument();
    });
  });
});

describe('Attention severity dot branches', () => {
  function setup(items: unknown[]) {
    mockedGet.mockImplementation((url: string) => {
      if (url.endsWith('/overview/')) return Promise.resolve({ data: OVERVIEW_RESPONSE });
      if (url.endsWith('/attention/')) return Promise.resolve({ data: { items } });
      if (url.endsWith('/my-tasks/')) return Promise.resolve({ data: MY_TASKS_RESPONSE });
      if (url === '/tasks/') return Promise.resolve({ data: CP_TASKS_RESPONSE });
      if (url.endsWith('/monte-carlo/latest/')) return Promise.reject(new Error('404'));
      return Promise.reject(new Error(url));
    });
  }

  it.each(['critical', 'warning', 'info'])('renders the %s severity dot', async (sev) => {
    setup([
      {
        severity: sev,
        type: 'critical_task_late',
        task_id: 't',
        task_name: `T-${sev}`,
        message: '',
        assignee_name: null,
        date: '2026-05-01',
        detail: 'd',
        link_target: null,
      },
    ]);
    renderPage();
    await waitFor(() => {
      expect(screen.getByLabelText(`${sev} severity`)).toBeInTheDocument();
    });
  });

  it('omits the date column when item has no date', async () => {
    setup([
      {
        severity: 'info',
        type: 'critical_task_late',
        task_id: 't',
        task_name: 'NoDate',
        message: '',
        assignee_name: null,
        date: null,
        detail: 'd',
        link_target: null,
      },
    ]);
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('NoDate')).toBeInTheDocument();
    });
  });
});

describe('MC histogram (shared MonteCarloHistogram, #1774)', () => {
  it('renders neutral distribution bars with semantic percentile rule lines (rule 19)', async () => {
    const mc = {
      p50: '2026-06-01',
      p80: '2026-06-15',
      p95: '2026-06-30',
      runs: 500,
      distribution: [],
      histogram_buckets: [
        { date: '2026-05-15', count: 5 },
        { date: '2026-06-10', count: 9 },
        { date: '2026-06-20', count: 3 },
      ],
    };
    mockedGet.mockImplementation((url: string) => {
      if (url.endsWith('/overview/')) return Promise.resolve({ data: OVERVIEW_RESPONSE });
      if (url.endsWith('/attention/')) return Promise.resolve({ data: ATTENTION_RESPONSE });
      if (url.endsWith('/my-tasks/')) return Promise.resolve({ data: MY_TASKS_RESPONSE });
      if (url === '/tasks/') return Promise.resolve({ data: CP_TASKS_RESPONSE });
      if (url.endsWith('/monte-carlo/latest/')) return Promise.resolve({ data: mc });
      return Promise.reject(new Error(url));
    });
    const { container } = renderPage();
    await waitFor(() => {
      expect(screen.getByText(/8 in 10 simulations finish by/i)).toBeInTheDocument();
    });
    const rects = container.querySelectorAll('rect');
    expect(rects.length).toBe(3);
    // Distribution shape is neutral — the ≥3:1 chart-neutral mark (WCAG 1.4.11),
    // no semantic color, no hardcoded hex (rule 19).
    rects.forEach((r) => {
      expect(r.getAttribute('class')).toContain('fill-chart-neutral');
      expect(r.getAttribute('fill')).toBeNull();
    });
    expect(container.innerHTML).not.toContain('#4ade80');
    expect(container.innerHTML).not.toContain('#f59e0b');
    expect(container.innerHTML).not.toContain('#b91c1c');
    // Semantic color is reserved for the P50/P80/P95 vertical rule lines.
    const lineClasses = Array.from(container.querySelectorAll('line')).map(
      (l) => l.getAttribute('class') ?? '',
    );
    expect(lineClasses.some((c) => c.includes('stroke-semantic-on-track'))).toBe(true);
    expect(lineClasses.some((c) => c.includes('stroke-semantic-at-risk'))).toBe(true);
    expect(lineClasses.some((c) => c.includes('stroke-semantic-critical'))).toBe(true);
  });

  it('renders no svg when histogram_buckets is empty', async () => {
    const mc = {
      p50: '2026-06-01',
      p80: '2026-06-15',
      p95: '2026-06-30',
      runs: 0,
      distribution: [],
      histogram_buckets: [],
    };
    mockedGet.mockImplementation((url: string) => {
      if (url.endsWith('/overview/')) return Promise.resolve({ data: OVERVIEW_RESPONSE });
      if (url.endsWith('/attention/')) return Promise.resolve({ data: ATTENTION_RESPONSE });
      if (url.endsWith('/my-tasks/')) return Promise.resolve({ data: MY_TASKS_RESPONSE });
      if (url === '/tasks/') return Promise.resolve({ data: CP_TASKS_RESPONSE });
      if (url.endsWith('/monte-carlo/latest/')) return Promise.resolve({ data: mc });
      return Promise.reject(new Error(url));
    });
    const { container } = renderPage();
    await waitFor(() => {
      expect(screen.getByText(/8 in 10 simulations finish by/i)).toBeInTheDocument();
    });
    expect(container.querySelectorAll('rect').length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Methodology-adaptive widget gating (#1765). The Overview must not push one
// workflow's chrome at the other methodology's single-workflow team.
// ---------------------------------------------------------------------------

describe('methodology-adaptive widget gating (#1765)', () => {
  /** Mock every Overview endpoint, with the project detail carrying the given
   *  effective methodology + surface visibility. */
  function setupMethodology(
    effective_methodology: string,
    effective_surface_visibility: Record<string, boolean>,
  ) {
    mockedGet.mockImplementation((url: string) => {
      if (url === '/projects/proj-1/')
        return Promise.resolve({
          data: { ...PROJECT_DETAIL, effective_methodology, effective_surface_visibility },
        });
      if (url.endsWith('/members/')) return Promise.resolve({ data: SELF_MEMBERSHIP_MEMBER });
      if (url.endsWith('/overview/')) return Promise.resolve({ data: OVERVIEW_RESPONSE });
      if (url.endsWith('/attention/')) return Promise.resolve({ data: ATTENTION_RESPONSE });
      if (url.endsWith('/my-tasks/')) return Promise.resolve({ data: MY_TASKS_RESPONSE });
      if (url === '/tasks/') return Promise.resolve({ data: CP_TASKS_RESPONSE });
      if (url.endsWith('/monte-carlo/latest/')) return Promise.reject(new Error('404'));
      if (url.endsWith('/sprint-forecast/'))
        return Promise.resolve({ data: { status: 'insufficient_history' } });
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });
  }

  // The widgets are all visible under the pre-load HYBRID / all-visible default, so
  // each test anchors on a widget that DISAPPEARS once the project detail settles to
  // the target methodology — a positive "loaded" signal — before asserting the rest.

  it('AGILE hides Monte Carlo + Critical path, keeps Backlog forecast', async () => {
    // AGILE defaults monte_carlo off (ADR-0193) and hides the schedule tab (ADR-0041).
    setupMethodology('AGILE', {
      reporting: true,
      time_tracking: true,
      baselines: false,
      monte_carlo: false,
    });
    renderPage();
    await waitFor(() =>
      expect(
        screen.queryByRole('region', { name: /monte carlo forecast/i }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole('region', { name: /critical path/i })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: /backlog forecast/i })).toBeInTheDocument();
  });

  it('WATERFALL hides Backlog forecast, keeps Monte Carlo + Critical path', async () => {
    setupMethodology('WATERFALL', {
      reporting: true,
      time_tracking: true,
      baselines: true,
      monte_carlo: true,
    });
    renderPage();
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: /backlog forecast/i })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('region', { name: /monte carlo forecast/i })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /critical path/i })).toBeInTheDocument();
  });

  it('HYBRID shows all three cross-methodology widgets', async () => {
    setupMethodology('HYBRID', {
      reporting: true,
      time_tracking: true,
      baselines: true,
      monte_carlo: true,
    });
    renderPage();
    expect(await screen.findByRole('region', { name: /backlog forecast/i })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /monte carlo forecast/i })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /critical path/i })).toBeInTheDocument();
  });

  it('AGILE with an admin override re-enabling monte_carlo shows Monte Carlo', async () => {
    // Hide-only surfaces are a preference: an AGILE admin can turn Monte Carlo back on
    // (ADR-0193), so the gate must follow effective_surface_visibility, not methodology.
    setupMethodology('AGILE', {
      reporting: true,
      time_tracking: true,
      baselines: false,
      monte_carlo: true,
    });
    renderPage();
    // Critical path is still methodology-gated (no surface key) → its removal is the
    // signal that the AGILE detail has settled.
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: /critical path/i })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('region', { name: /monte carlo forecast/i })).toBeInTheDocument();
  });
});

describe('zero-task Overview — no empty card (#2733)', () => {
  /** Mock every Overview endpoint with a zero-task overview and the given self role. */
  function setupZeroTask(opts: { effective_methodology?: string; role?: number } = {}) {
    const { effective_methodology = 'HYBRID', role = 100 } = opts;
    mockedGet.mockImplementation((url: string) => {
      if (url === '/projects/proj-1/')
        return Promise.resolve({ data: { ...PROJECT_DETAIL, effective_methodology } });
      if (url.endsWith('/members/')) return Promise.resolve({ data: [{ id: 'me', role }] });
      if (url.endsWith('/overview/'))
        return Promise.resolve({ data: { ...OVERVIEW_RESPONSE, total_tasks: 0 } });
      if (url.endsWith('/attention/')) return Promise.resolve({ data: ATTENTION_RESPONSE });
      if (url.endsWith('/my-tasks/')) return Promise.resolve({ data: MY_TASKS_RESPONSE });
      if (url === '/tasks/') return Promise.resolve({ data: CP_TASKS_RESPONSE });
      if (url.endsWith('/monte-carlo/latest/')) return Promise.reject(new Error('404'));
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });
  }

  it('renders no "add your first task" card at all (#2733)', async () => {
    // The card is DELETED, not restyled. #2048 swapped the whole Overview body for
    // a CTA on a zero-task project; #2733 moves the blank-project moment onto the
    // Schedule, where the outline opens with a live row and the caret already in
    // it. A card that says "add your first task" on a surface that cannot add one
    // is a detour, so no shared empty card survives here.
    setupZeroTask();
    renderPage();

    await screen.findByRole('heading', { name: /dashboard/i });
    expect(screen.queryByRole('heading', { name: /add your first task/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add your first task/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /invite teammates/i })).not.toBeInTheDocument();
  });

  it('renders the ordinary Dashboard body on a zero-task project', async () => {
    // The KPI dashboard is no longer swapped out — a project with no work reads as
    // a plan surface waiting for work, not as a failure state.
    setupZeroTask();
    renderPage();
    expect(await screen.findByRole('heading', { name: /dashboard/i })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Team utilization card — rule 119 muted treatment + reason line (#2428)
// ---------------------------------------------------------------------------

describe('ProjectOverviewPage — team utilization (#2428)', () => {
  /** Re-point the overview endpoint at a utilization-specific payload. */
  function withUtilization(overrides: Record<string, unknown>) {
    mockedGet.mockImplementation((url: string) => {
      const header = headerHookResponse(url);
      if (header) return Promise.resolve(header);
      if (url.endsWith('/overview/'))
        return Promise.resolve({ data: { ...OVERVIEW_RESPONSE, ...overrides } });
      if (url.endsWith('/attention/')) return Promise.resolve({ data: ATTENTION_RESPONSE });
      if (url.endsWith('/my-tasks/')) return Promise.resolve({ data: MY_TASKS_RESPONSE });
      if (url === '/tasks/') return Promise.resolve({ data: CP_TASKS_RESPONSE });
      if (url.endsWith('/monte-carlo/latest/')) return Promise.reject(new Error('404'));
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });
  }

  it('renders a plain-language reason instead of a bare em-dash', async () => {
    // The bug: value "—" with an empty sub slot, while both neighbouring cards
    // carried one — leaving the user unable to tell "no one is allocated" from
    // "this is broken".
    withUtilization({ team_utilization_pct: null, team_utilization_reason: 'no_roster' });
    renderPage();
    expect(await screen.findByText('Needs people on the project roster')).toBeInTheDocument();
  });

  it('never renders the raw machine reason code', async () => {
    withUtilization({ team_utilization_pct: null, team_utilization_reason: 'no_capacity' });
    renderPage();
    expect(await screen.findByText('Roster has no working hours this week')).toBeInTheDocument();
    expect(screen.queryByText('no_capacity')).not.toBeInTheDocument();
  });

  it('falls back to a generic sentence for a reason code it does not know', async () => {
    // The server owns this vocabulary and may add a code before the web package
    // ships a label for it — that must not render `undefined` or the raw code.
    withUtilization({ team_utilization_pct: null, team_utilization_reason: 'no_such_reason' });
    renderPage();
    expect(await screen.findByText('Not available yet')).toBeInTheDocument();
    expect(screen.queryByText('no_such_reason')).not.toBeInTheDocument();
  });

  it('a real 0% is a value, not an unavailable card', async () => {
    // "Nobody is allocated this week" is a meaningful answer and must read as a
    // number — telling it apart from an undefined ratio is the point of #2428.
    withUtilization({ team_utilization_pct: 0, team_utilization_reason: null });
    renderPage();
    expect(await screen.findByText('0%')).toBeInTheDocument();
    expect(screen.getByText('of capacity this week')).toBeInTheDocument();
    expect(screen.queryByText('Needs people on the project roster')).not.toBeInTheDocument();
  });

  it('gives an unavailable card the rule-119 dashed border and no drill-down', async () => {
    withUtilization({ team_utilization_pct: null, team_utilization_reason: 'no_roster' });
    renderPage();
    const reason = await screen.findByText('Needs people on the project roster');
    const card = reason.closest('div');
    expect(card?.className).toContain('border-dashed');
    // Rule 172: a metric with no value has nothing to drill into, so the card is
    // a static read rather than a Link.
    expect(reason.closest('a')).toBeNull();
  });

  it('renders a computed percent as a live value with a drill-down for Scheduler+', async () => {
    withUtilization({ team_utilization_pct: 92.4, team_utilization_reason: null });
    renderPage();
    expect(await screen.findByText('92%')).toBeInTheDocument();
    expect(screen.getByText('of capacity this week')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Shared endpoint mock — every Overview read, with per-test overrides.
// ---------------------------------------------------------------------------

interface EndpointOverrides {
  overview?: () => Promise<unknown>;
  attention?: () => Promise<unknown>;
  myTasks?: () => Promise<unknown>;
  cpTasks?: () => Promise<unknown>;
  monteCarlo?: () => Promise<unknown>;
  project?: () => Promise<unknown>;
  role?: number;
}

function mockOverviewEndpoints(overrides: EndpointOverrides = {}) {
  mockedGet.mockImplementation((url: string): Promise<unknown> => {
    if (url === '/projects/proj-1/')
      return overrides.project?.() ?? Promise.resolve({ data: PROJECT_DETAIL });
    if (url.endsWith('/members/'))
      return Promise.resolve({ data: [{ id: 'me', role: overrides.role ?? 100 }] });
    if (url.endsWith('/overview/'))
      return overrides.overview?.() ?? Promise.resolve({ data: OVERVIEW_RESPONSE });
    if (url.endsWith('/attention/'))
      return overrides.attention?.() ?? Promise.resolve({ data: ATTENTION_RESPONSE });
    if (url.endsWith('/my-tasks/'))
      return overrides.myTasks?.() ?? Promise.resolve({ data: MY_TASKS_RESPONSE });
    if (url === '/tasks/')
      return overrides.cpTasks?.() ?? Promise.resolve({ data: CP_TASKS_RESPONSE });
    if (url.endsWith('/monte-carlo/latest/'))
      return overrides.monteCarlo?.() ?? Promise.reject(new Error('404'));
    return Promise.reject(new Error(`Unexpected URL: ${url}`));
  });
}

/** A resolved Monte Carlo payload with the given optional extras. */
function mcResult(extra: Record<string, unknown> = {}) {
  return {
    project_id: 'proj-1',
    p50: '2026-06-01',
    p80: '2026-06-15',
    p95: '2026-06-30',
    runs: 1000,
    distribution: [],
    histogram_buckets: [],
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Critical-path ordering — the comparator in useCriticalPathTasks
// ---------------------------------------------------------------------------

describe('critical path ordering', () => {
  it('sorts by total slack ascending and sinks unknown-slack tasks to the bottom', async () => {
    // Most negative float = longest delay, so it must lead. Tasks whose float the
    // scheduler could not compute are a weaker signal and go last.
    mockOverviewEndpoints({
      cpTasks: () =>
        Promise.resolve({
          data: {
            count: 4,
            next: null,
            previous: null,
            results: [
              { id: 'n1', name: 'Unknown slack A', duration: 4, total_float: null },
              { id: 'p1', name: 'Positive slack', duration: 5, total_float: 5 },
              { id: 'n2', name: 'Unknown slack B', duration: 6, total_float: null },
              { id: 'w1', name: 'Worst slack', duration: 10, total_float: -2 },
            ],
          },
        }),
    });
    renderPage();
    const list = await screen.findByRole('list', { name: /critical path tasks/i });
    const rows = within(list).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Worst slack');
    expect(rows[1]).toHaveTextContent('Positive slack');
    // Both unknown-slack rows tie and stay after the known-float ones.
    expect(`${rows[2].textContent ?? ''}${rows[3].textContent ?? ''}`).toContain('Unknown slack A');
    expect(`${rows[2].textContent ?? ''}${rows[3].textContent ?? ''}`).toContain('Unknown slack B');
  });
});

// ---------------------------------------------------------------------------
// Header subtitle
// ---------------------------------------------------------------------------

describe('ProjectHeader subtitle', () => {
  it('uses the singular "task" for a one-task project', async () => {
    mockOverviewEndpoints({
      overview: () => Promise.resolve({ data: { ...OVERVIEW_RESPONSE, total_tasks: 1 } }),
    });
    renderPage();
    expect(await screen.findByText(/1 task ·/)).toBeInTheDocument();
  });

  it('falls back to an em-dash when the project has no owner', async () => {
    mockOverviewEndpoints({
      overview: () => Promise.resolve({ data: { ...OVERVIEW_RESPONSE, owner_name: null } }),
    });
    renderPage();
    expect(await screen.findByText(/Owner: —/)).toBeInTheDocument();
  });

  it('closes the Update Status dialog again from its own close action', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /update status/i }));
    const dialog = await screen.findByRole('dialog', { name: /update project status/i });
    fireEvent.click(within(dialog).getByRole('button', { name: /close|cancel/i }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /update project status/i })).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Schedule-health metric copy
// ---------------------------------------------------------------------------

describe('Schedule health metric', () => {
  it.each([
    ['at_risk', 'At risk'],
    ['critical', 'Critical'],
  ])('reads "Behind schedule" for %s health', async (schedule_health, label) => {
    mockOverviewEndpoints({
      overview: () => Promise.resolve({ data: { ...OVERVIEW_RESPONSE, schedule_health } }),
    });
    renderPage();
    expect(await screen.findByText('Behind schedule')).toBeInTheDocument();
    expect(screen.getAllByText(label).length).toBeGreaterThan(0);
  });

  it('reads "Not yet computed" for unknown health and still links to the schedule', async () => {
    mockOverviewEndpoints({
      overview: () =>
        Promise.resolve({ data: { ...OVERVIEW_RESPONSE, schedule_health: 'unknown' } }),
    });
    renderPage();
    expect(await screen.findByText('Not yet computed')).toBeInTheDocument();
    // `unknown` is not a dead end — the schedule view is where the scheduler runs.
    expect(
      await screen.findByRole('link', { name: /schedule health.*view the schedule/i }),
    ).toHaveAttribute('href', '/projects/proj-1/schedule');
  });

  it('omits the SPI explainer title when the payload has no SPI', async () => {
    const { container } = (() => {
      mockOverviewEndpoints({
        overview: () => Promise.resolve({ data: { ...OVERVIEW_RESPONSE, spi: null } }),
      });
      return renderPage();
    })();
    await screen.findByText('On schedule');
    expect(container.querySelector('[title*="Schedule Performance Index"]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Team utilization variants
// ---------------------------------------------------------------------------

describe('Team utilization variants', () => {
  it('renders an over-capacity team in the critical tone', async () => {
    mockOverviewEndpoints({
      overview: () =>
        Promise.resolve({ data: { ...OVERVIEW_RESPONSE, team_utilization_pct: 120 } }),
    });
    renderPage();
    expect((await screen.findByText('120%')).className).toContain('text-semantic-critical');
  });

  it('renders a nearly-full team in the at-risk tone', async () => {
    mockOverviewEndpoints({
      overview: () => Promise.resolve({ data: { ...OVERVIEW_RESPONSE, team_utilization_pct: 90 } }),
    });
    renderPage();
    expect((await screen.findByText('90%')).className).toContain('text-semantic-at-risk');
  });

  it('renders a comfortable team in the on-track tone', async () => {
    mockOverviewEndpoints();
    renderPage();
    expect((await screen.findByText('78%')).className).toContain('text-semantic-on-track');
  });

  it('falls back to a generic sentence when the server sends no reason at all', async () => {
    // Rule 119: a blank card always explains itself, even when the server omits
    // the machine code entirely.
    mockOverviewEndpoints({
      overview: () =>
        Promise.resolve({ data: { ...OVERVIEW_RESPONSE, team_utilization_pct: null } }),
    });
    renderPage();
    expect(await screen.findByText('Not available yet')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Next-milestone countdown copy
// ---------------------------------------------------------------------------

describe('Next milestone countdown', () => {
  beforeEach(() => {
    // Pin the clock: the countdown is a date subtraction, and a real "now" makes
    // the Today/in-Nd boundary depend on the runner's wall clock and time zone.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-27T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function withMilestone(date: string) {
    mockOverviewEndpoints({
      overview: () =>
        Promise.resolve({
          data: {
            ...OVERVIEW_RESPONSE,
            next_milestone: { id: 'm1', name: 'Phase gate', date, percent_complete: 0 },
          },
        }),
    });
  }

  it('reads "Today" for a milestone due today', async () => {
    withMilestone('2026-07-27');
    renderPage();
    expect(await screen.findByText('Today')).toBeInTheDocument();
  });

  it('counts forward for a future milestone', async () => {
    withMilestone('2026-08-01');
    renderPage();
    expect(await screen.findByText('in 5d')).toBeInTheDocument();
  });

  it('counts backward for a milestone already past', async () => {
    withMilestone('2026-07-20');
    renderPage();
    expect(await screen.findByText('7d ago')).toBeInTheDocument();
  });

  it('omits the countdown from the card label when the milestone has no date', async () => {
    mockOverviewEndpoints({
      overview: () =>
        Promise.resolve({
          data: {
            ...OVERVIEW_RESPONSE,
            next_milestone: { id: 'm1', name: 'Phase gate', date: '', percent_complete: 0 },
          },
        }),
    });
    renderPage();
    // Still a drill-down, but the accessible name carries no dangling subtitle.
    const link = await screen.findByRole('link', { name: /next milestone.*view the milestone/i });
    expect(link).toHaveAccessibleName('Next milestone: Phase gate. View the milestone.');
  });
});

// ---------------------------------------------------------------------------
// Monte Carlo widget — rerun / run interactions
// ---------------------------------------------------------------------------

describe('Monte Carlo widget interactions', () => {
  it('posts a run and shows "Running…" from the empty state', async () => {
    mockedPost.mockReturnValue(new Promise(() => {}));
    mockOverviewEndpoints();
    renderPage();
    const run = await screen.findByRole('button', { name: /^run forecast$/i });
    fireEvent.click(run);
    expect(await screen.findByRole('button', { name: /running…/i })).toBeDisabled();
    await waitFor(() => {
      expect(mockedPost).toHaveBeenCalledWith('/projects/proj-1/monte-carlo/', {});
    });
  });

  it('shows "Rerunning…" while a rerun of a cached forecast is in flight', async () => {
    mockedPost.mockReturnValue(new Promise(() => {}));
    mockOverviewEndpoints({ monteCarlo: () => Promise.resolve({ data: mcResult() }) });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /rerun forecast/i }));
    expect(await screen.findByRole('button', { name: /rerunning…/i })).toBeDisabled();
  });

  it('surfaces an inline alert when the rerun request fails', async () => {
    mockedPost.mockRejectedValue(new Error('500'));
    mockOverviewEndpoints({ monteCarlo: () => Promise.resolve({ data: mcResult() }) });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /rerun forecast/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not rerun. Try again.');
  });

  it('omits the last-run line when the cached result carries no timestamp', async () => {
    mockOverviewEndpoints({ monteCarlo: () => Promise.resolve({ data: mcResult() }) });
    renderPage();
    await screen.findByRole('button', { name: /rerun forecast/i });
    expect(screen.queryByText(/last run/i)).not.toBeInTheDocument();
  });

  it('shows a busy placeholder instead of the forecast while it loads', async () => {
    mockOverviewEndpoints({ monteCarlo: () => new Promise(() => {}) });
    renderPage();
    const section = await screen.findByRole('region', { name: /monte carlo forecast/i });
    // Neither the result chips nor the empty-state CTA — a loading forecast is
    // its own state, not "no forecast available".
    expect(within(section).queryByRole('button', { name: /forecast/i })).toBeNull();
    expect(within(section).queryByText(/no forecast available/i)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// My tasks — critical-path chip inside the my-tasks list
// ---------------------------------------------------------------------------

describe('My tasks critical-path chip', () => {
  function withMyTask(extra: Record<string, unknown>) {
    mockOverviewEndpoints({
      myTasks: () =>
        Promise.resolve({
          data: {
            tasks: [
              {
                id: 't1',
                name: 'Write specs',
                due: '2026-04-18',
                status: 'IN_PROGRESS',
                percent_complete: 40,
                is_critical: false,
                ...extra,
              },
            ],
          },
        }),
    });
  }

  it('flags a critical-path task with a CP chip and names it in the row label', async () => {
    withMyTask({ is_critical: true });
    renderPage();
    const list = await screen.findByRole('list', { name: /my tasks due this week/i });
    expect(within(list).getByText('CP')).toBeInTheDocument();
    expect(
      within(list).getByRole('link', { name: /Write specs, 40% complete, on the critical path/i }),
    ).toBeInTheDocument();
  });

  it('omits the CP chip for an off-critical-path task', async () => {
    withMyTask({ is_critical: false });
    renderPage();
    const list = await screen.findByRole('list', { name: /my tasks due this week/i });
    expect(within(list).queryByText('CP')).toBeNull();
    expect(
      within(list).getByRole('link', { name: /^Write specs, 40% complete\. View task\.$/ }),
    ).toBeInTheDocument();
  });

  it('omits the due column when a task has no due date', async () => {
    withMyTask({ due: null });
    renderPage();
    const list = await screen.findByRole('list', { name: /my tasks due this week/i });
    expect(within(list).queryByText('2026-04-18')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Retry — every panel's error banner must actually refetch (#1764)
// ---------------------------------------------------------------------------

describe('panel retry actions', () => {
  /** Reject the first read of `key`, then serve its normal payload — so the
   *  Retry button's refetch is what actually recovers the panel. */
  function setupFailOnce(key: 'overview' | 'attention' | 'myTasks' | 'cpTasks') {
    let calls = 0;
    const payload = {
      overview: { data: OVERVIEW_RESPONSE },
      attention: { data: ATTENTION_RESPONSE },
      myTasks: { data: MY_TASKS_RESPONSE },
      cpTasks: { data: CP_TASKS_RESPONSE },
    }[key];
    mockOverviewEndpoints({
      [key]: () => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error('500')) : Promise.resolve(payload);
      },
    });
  }

  it('recovers the project-health row when Retry is pressed', async () => {
    setupFailOnce('overview');
    renderPage();
    const health = await screen.findByRole('region', { name: /project health/i });
    fireEvent.click(await within(health).findByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('On schedule')).toBeInTheDocument();
  });

  it('recovers the attention panel when Retry is pressed', async () => {
    setupFailOnce('attention');
    renderPage();
    const attention = await screen.findByRole('region', { name: /attention items/i });
    fireEvent.click(await within(attention).findByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/no items need attention/i)).toBeInTheDocument();
  });

  it('recovers the my-tasks panel when Retry is pressed', async () => {
    setupFailOnce('myTasks');
    renderPage();
    const mine = await screen.findByRole('region', { name: /my tasks this week/i });
    await waitFor(() => {
      expect(within(mine).getByRole('status')).toHaveTextContent(/Couldn't load your tasks\./);
    });
    fireEvent.click(within(mine).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/no tasks assigned/i)).toBeInTheDocument();
  });

  it('recovers the critical-path panel when Retry is pressed', async () => {
    setupFailOnce('cpTasks');
    renderPage();
    const cp = await screen.findByRole('region', { name: /^critical path$/i });
    await waitFor(() => {
      expect(within(cp).getByRole('status')).toHaveTextContent(/Couldn't load the critical path\./);
    });
    fireEvent.click(within(cp).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/no critical path tasks found/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Independent panel loading states
// ---------------------------------------------------------------------------

describe('independent panel loading states', () => {
  it('keeps the my-tasks panel busy while the attention panel has already resolved', async () => {
    mockOverviewEndpoints({ myTasks: () => new Promise(() => {}) });
    renderPage();
    expect(await screen.findByText(/no items need attention/i)).toBeInTheDocument();
    const mine = screen.getByRole('region', { name: /my tasks this week/i });
    // Still loading: no list, no empty copy, no error banner.
    expect(within(mine).queryByRole('list')).toBeNull();
    expect(within(mine).queryByText(/no tasks assigned/i)).toBeNull();
    expect(within(mine).queryByRole('status')).toBeNull();
  });

  it('keeps the attention panel busy while the my-tasks panel has already resolved', async () => {
    mockOverviewEndpoints({ attention: () => new Promise(() => {}) });
    renderPage();
    expect(await screen.findByText(/no tasks assigned/i)).toBeInTheDocument();
    const attention = screen.getByRole('region', { name: /attention items/i });
    expect(within(attention).queryByText(/no items need attention/i)).toBeNull();
    expect(within(attention).queryByRole('list')).toBeNull();
  });

  it('keeps the critical-path panel busy until its fetch resolves', async () => {
    mockOverviewEndpoints({ cpTasks: () => new Promise(() => {}) });
    renderPage();
    const cp = await screen.findByRole('region', { name: /^critical path$/i });
    expect(within(cp).queryByText(/no critical path tasks found/i)).toBeNull();
    expect(within(cp).queryByRole('list')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// No project id yet — the pre-route placeholder set (rule 172)
// ---------------------------------------------------------------------------

describe('Overview with no resolved project id', () => {
  it('renders a static, non-clickable placeholder KPI set', async () => {
    projectIdRef.current = undefined;
    mockOverviewEndpoints();
    renderPage();

    // The calm heading, not an alarm — an unknown project is not a bad project.
    expect(await screen.findByRole('region', { name: /project health/i })).toBeInTheDocument();
    expect(screen.getByText(/^Schedule health$/)).toBeInTheDocument();
    expect(screen.getByText(/^Next milestone$/)).toBeInTheDocument();
    // Added time renders even with no project resolved, in its not-run state.
    expect(
      screen.getByRole('region', { name: /added time vs computed finish/i }),
    ).toBeInTheDocument();

    // Nothing is addressable yet, so no card may be a drill-down link.
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    // …and none of the project-scoped panels mount.
    expect(screen.queryByRole('region', { name: /attention items/i })).toBeNull();
    expect(screen.queryByRole('region', { name: /burn-up chart/i })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The commit moment (#3129) — Draft pill, Commit plan button, confirm sheet
// ---------------------------------------------------------------------------

/**
 * Render the header with an explicit lifecycle + role, which the default fixture
 * deliberately omits: `PROJECT_DETAIL` carries no `lifecycle` and the self-membership
 * row is a Member (100), so every pre-existing test in this file renders neither the
 * pill nor the button. That is the point — absent lifecycle must never read as draft.
 */
function mockHeaderState(opts: { lifecycle?: 'draft' | 'active'; role: number }) {
  mockedGet.mockImplementation((url: string) => {
    if (url === '/projects/proj-1/') {
      return Promise.resolve({
        data: { ...PROJECT_DETAIL, ...(opts.lifecycle ? { lifecycle: opts.lifecycle } : {}) },
      });
    }
    if (url.endsWith('/members/'))
      return Promise.resolve({ data: [{ id: 'me', role: opts.role }] });
    if (url.endsWith('/overview/')) return Promise.resolve({ data: OVERVIEW_RESPONSE });
    if (url.endsWith('/attention/')) return Promise.resolve({ data: ATTENTION_RESPONSE });
    if (url.endsWith('/my-tasks/')) return Promise.resolve({ data: MY_TASKS_RESPONSE });
    if (url === '/tasks/') return Promise.resolve({ data: CP_TASKS_RESPONSE });
    if (url.endsWith('/monte-carlo/latest/')) return Promise.reject(new Error('404'));
    return Promise.reject(new Error(`Unexpected URL: ${url}`));
  });
}

// A string `name` is already an exact accessible-name match in Testing Library, so
// this cannot also bind the dialog's confirm button while the sheet is closed — and
// the sheet-open tests scope through `within(dialog)` rather than this helper.
const commitButton = () => screen.queryByRole('button', { name: 'Commit plan' });

describe('ProjectOverviewPage — the commit moment (#3129)', () => {
  it('shows the Draft pill and the Commit plan button to an Admin on a draft', async () => {
    mockHeaderState({ lifecycle: 'draft', role: 300 });
    renderPage();
    expect(await screen.findByLabelText('Project lifecycle: Draft')).toBeInTheDocument();
    await waitFor(() => expect(commitButton()).toBeInTheDocument());
  });

  it('shows the Draft pill but NOT the button to a Scheduler', async () => {
    // The boundary #3129 moved. A Scheduler must still be able to see that the plan
    // has not been agreed to — the pill is state disclosure, the button is capability.
    mockHeaderState({ lifecycle: 'draft', role: 200 });
    renderPage();
    const pill = await screen.findByLabelText('Project lifecycle: Draft');
    // Rendered text, not the attribute — the consequence must survive a fast visual
    // scan, and a bare `title` is unreachable on touch (rules 287/328b). The whole
    // list is asserted, including My Work, which used to live only in that `title`.
    expect(pill).toHaveTextContent('Draft');
    expect(pill).not.toHaveAttribute('title');
    await waitFor(() => expect(screen.getByText(DRAFT_EXCLUSION_SENTENCE)).toBeInTheDocument());
    expect(DRAFT_EXCLUSION_SENTENCE).toMatch(/My Work/);
    expect(commitButton()).not.toBeInTheDocument();
  });

  it('shows neither once the plan is active', async () => {
    mockHeaderState({ lifecycle: 'active', role: 300 });
    renderPage();
    await screen.findByRole('button', { name: /update status/i });
    expect(screen.queryByLabelText('Project lifecycle: Draft')).not.toBeInTheDocument();
    expect(commitButton()).not.toBeInTheDocument();
  });

  it('treats an ABSENT lifecycle as unknown, never as draft', async () => {
    // A response cached before #3129 carries no `lifecycle`. Defaulting it to draft
    // would offer a one-way Commit on an already-committed plan.
    mockHeaderState({ role: 300 });
    renderPage();
    await screen.findByRole('button', { name: /update status/i });
    expect(screen.queryByLabelText('Project lifecycle: Draft')).not.toBeInTheDocument();
    expect(commitButton()).not.toBeInTheDocument();
  });

  it('opens a confirm sheet that states BOTH what commit does and the Amend change', async () => {
    // UX-REVIEW §4 requires both halves. The Amend sentence is the one that explains
    // why this is a one-way door rather than a save, so it is asserted explicitly
    // rather than left to a generic "dialog is visible" check.
    mockHeaderState({ lifecycle: 'draft', role: 300 });
    renderPage();
    await waitFor(() => expect(commitButton()).toBeInTheDocument());
    fireEvent.click(commitButton()!);

    const dialog = await screen.findByRole('dialog', { name: /commit this plan/i });
    expect(within(dialog).getByText(/Baseline v1/)).toBeInTheDocument();
    expect(within(dialog).getByText(/working calendar/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/amending/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/cannot un-commit/i)).toBeInTheDocument();
    // The honest half of the Amend sentence is present...
    expect(within(dialog).getByText(/recorded in plan history/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/tells the people whose work moved/i)).toBeInTheDocument();
    // ...and the claim the client cannot yet deliver is absent, across phrasings
    // rather than against the one retired wording (rule 308d). `amend_reason` is a
    // real write-only serializer field with zero senders in packages/web — #3150 owns
    // the prompt that collects it — so until then no copy may say a reason is
    // captured. Nor may anything claim committing notifies: `commit_project()` writes
    // no notification row, which is why #3129 renamed `notified_resource_count`.
    expect(
      within(dialog).queryByText(/carries a reason|reason for the change|asks you why/i),
    ).toBeNull();
    expect(within(dialog).queryByText(/notif|the team is told|we'll let/i)).toBeNull();
  });

  it('does not offer a re-baseline or "keep v1" exit — #3150 owns the second exit', async () => {
    // A sheet offering only re-baseline teaches people to launder slip (UX-REVIEW §4).
    mockHeaderState({ lifecycle: 'draft', role: 300 });
    renderPage();
    await waitFor(() => expect(commitButton()).toBeInTheDocument());
    fireEvent.click(commitButton()!);

    const dialog = await screen.findByRole('dialog', { name: /commit this plan/i });
    expect(
      within(dialog).queryByText(/re-baseline|rebaseline|keep v1|let variance stand/i),
    ).toBeNull();
    // Exactly two controls: Cancel and Commit plan.
    expect(within(dialog).getAllByRole('button')).toHaveLength(2);
  });

  it('POSTs to /commit/ on confirm and closes the sheet', async () => {
    mockHeaderState({ lifecycle: 'draft', role: 300 });
    mockedPost.mockResolvedValue({
      data: {
        baseline_id: 'b-1',
        baseline_name: 'Baseline v1',
        task_count: 12,
        assigned_resource_count: 4,
      },
    });
    renderPage();
    await waitFor(() => expect(commitButton()).toBeInTheDocument());
    fireEvent.click(commitButton()!);

    const dialog = await screen.findByRole('dialog', { name: /commit this plan/i });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Commit plan' }));

    await waitFor(() => expect(mockedPost).toHaveBeenCalledWith('/projects/proj-1/commit/'));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /commit this plan/i })).not.toBeInTheDocument(),
    );
  });

  it('keeps the sheet open and does not re-POST while a commit is in flight', async () => {
    // One-way act: a double-click must not fire two POSTs, and the sheet must not
    // vanish mid-write leaving no signal about an irreversible operation.
    mockHeaderState({ lifecycle: 'draft', role: 300 });
    let resolvePost: (v: unknown) => void = () => {};
    mockedPost.mockImplementation(
      () =>
        new Promise((r) => {
          resolvePost = r;
        }),
    );
    renderPage();
    await waitFor(() => expect(commitButton()).toBeInTheDocument());
    fireEvent.click(commitButton()!);

    const dialog = await screen.findByRole('dialog', { name: /commit this plan/i });
    const confirm = within(dialog).getByRole('button', { name: 'Commit plan' });
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: /committing…/i })).toBeDisabled(),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: /committing…/i }));
    expect(mockedPost).toHaveBeenCalledTimes(1);

    resolvePost({
      data: {
        baseline_id: 'b-1',
        baseline_name: 'Baseline v1',
        task_count: 1,
        assigned_resource_count: 0,
      },
    });
  });
});
