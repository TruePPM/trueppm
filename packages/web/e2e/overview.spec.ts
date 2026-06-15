import { test, expect } from '@playwright/test';

/**
 * Project overview page E2E tests (issue #99).
 *
 * Golden path: navigate to /projects/:id/overview and verify the KPI cards,
 * attention panel, and my-tasks panel render without error.
 *
 * Error state: verify the page degrades gracefully when overview API returns 500.
 */

const PROJECT_ID = 'e2e-overview-00000000-0000-0000-0000-000000000099';

const FIXTURE_PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Overview Test Project',
    description: '',
    start_date: '2026-01-01',
    calendar: 'default',
  },
];

const FIXTURE_OVERVIEW = {
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
};

const FIXTURE_ATTENTION = {
  items: [
    {
      severity: 'critical',
      type: 'critical_task_late',
      task_id: 't1',
      task_name: 'Foundation work',
      assignee_name: null,
      date: '2026-04-10',
      detail: 'On critical path',
    },
  ],
};

const FIXTURE_MY_TASKS = {
  tasks: [
    {
      id: 't2',
      name: 'Write specs',
      due: '2026-04-18',
      status: 'IN_PROGRESS',
      percent_complete: 40,
      is_critical: false,
    },
  ],
};

async function setupRoutes(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });

  await page.route(`**/api/v1/projects/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        count: FIXTURE_PROJECTS.length,
        next: null,
        previous: null,
        results: FIXTURE_PROJECTS,
      }),
    }),
  );

  await page.route(`**/api/v1/projects/${PROJECT_ID}/overview/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(FIXTURE_OVERVIEW),
    }),
  );

  await page.route(`**/api/v1/projects/${PROJECT_ID}/attention/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(FIXTURE_ATTENTION),
    }),
  );

  await page.route(`**/api/v1/projects/${PROJECT_ID}/my-tasks/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(FIXTURE_MY_TASKS),
    }),
  );

  // Backlog delivery forecast (#487) — a ready velocity Monte Carlo result.
  await page.route(`**/api/v1/projects/${PROJECT_ID}/sprint-forecast/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'ready',
        remaining_points: 60,
        sample_count: 3,
        p50_sprints: 3,
        p80_sprints: 4,
        p50_date: '2026-08-01',
        p80_date: '2026-08-15',
        basis: 'monte_carlo',
        velocity_suppressed: false,
      }),
    }),
  );

  await page.route('**/api/v1/projects/*/presence/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  await page.route('**/api/v1/projects/*/status-summary/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        task_count: 0,
        critical_path_count: 0,
        monte_carlo_p80: null,
        at_risk_count: 0,
        critical_count: 0,
        at_risk_tasks: [],
        critical_tasks: [],
        last_saved: null,
        recalculated_at: null,
      }),
    }),
  );
  // MC latest: 404 means no simulation run yet
  await page.route('**/api/v1/projects/*/monte-carlo/latest/', (route) =>
    route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ detail: 'No simulation result available.' }) }),
  );
  // Tasks + dependencies — needed by useCriticalPathTasks and the Schedule view.
  // Without these stubs the unstubbed request hits the real API with the e2e token,
  // returns 401, and triggers the auth redirect before tests can assert.
  await page.route('**/api/v1/tasks/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
  await page.route('**/api/v1/dependencies/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
}

test.describe('Project overview page', () => {
  test.beforeEach(async ({ page }) => {
    await setupRoutes(page);
    await page.goto(`/projects/${PROJECT_ID}/overview`);
    // Wait for the ranked KPI focus section (#1191). Its heading is calm-aware
    // ("Project health" before data / when all-neutral, "Needs attention" once
    // an at-risk metric loads), so gate on the always-present secondary strip
    // heading instead — it renders as soon as the page mounts and never changes.
    await expect(page.getByRole('region', { name: /more metrics/i })).toBeVisible({
      timeout: 10_000,
    });
  });

  test('renders the backlog delivery forecast (#487)', async ({ page }) => {
    const region = page.getByRole('region', { name: /backlog forecast/i });
    await expect(region).toBeVisible();
    // Monte Carlo basis → P50/P80 percentile vocabulary is shown (web-rule 166).
    await expect(region.getByText(/forecast to clear by/i)).toBeVisible();
    await expect(region.getByText(/P50/)).toBeVisible();
    await expect(region.getByText(/P80/)).toBeVisible();
  });

  test('golden path — KPI cards, attention panel, and my-tasks all render', async ({ page }) => {
    // KPI card labels
    await expect(page.getByText(/schedule health/i)).toBeVisible();
    await expect(page.getByText(/tasks late/i)).toBeVisible();
    await expect(page.getByText(/next milestone/i)).toBeVisible();

    // Loaded KPI values — two 'On track' elements exist (header badge + KPI card), use first()
    await expect(page.getByText('On track').first()).toBeVisible();
    await expect(page.getByText('Phase gate')).toBeVisible();
    await expect(page.getByText('78%')).toBeVisible();

    // Attention panel
    await expect(page.getByRole('region', { name: /attention items/i })).toBeVisible();
    await expect(page.getByText('Foundation work')).toBeVisible();

    // My-tasks panel
    await expect(page.getByRole('region', { name: /my tasks this week/i })).toBeVisible();
    await expect(page.getByText('Write specs')).toBeVisible();
  });

  test('URL uses path-based routing — /projects/:id/overview', async ({ page }) => {
    expect(page.url()).toMatch(new RegExp(`/projects/${PROJECT_ID}/overview`));
    expect(page.url()).not.toContain('?project=');
  });

  test('Overview tab is active in ViewTabs nav', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: 'View' });
    await expect(nav.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
  });

  test('navigate to Schedule view from overview', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: 'View' });
    await nav.getByRole('link', { name: 'Schedule' }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/schedule`));
    await expect(nav.getByRole('link', { name: 'Schedule' })).toHaveAttribute('aria-current', 'page');
  });

  test('error state — overview API 500 does not crash the page', async ({ page }) => {
    // Intercept to return 500 for this test only (page already loaded; navigate fresh)
    await page.route(`**/api/v1/projects/${PROJECT_ID}/overview/`, (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }),
    );
    await page.reload();
    // Page should still render — the secondary "More metrics" strip is always
    // present even when overview data is empty (#1191).
    await expect(page.getByRole('region', { name: /more metrics/i })).toBeVisible({
      timeout: 10_000,
    });
  });

  test('project header shows health badge and project name', async ({ page }) => {
    // Health badge is rendered in the header (On track)
    await expect(page.getByText('On track').first()).toBeVisible();
    // Owner visible in subtitle
    await expect(page.getByText(/Owner: Alice Smith/)).toBeVisible();
    // Export and Update Status buttons present. Use exact name on Export because the
    // BurnChart card on this page also renders a button with accessible name "Export chart".
    await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /update status/i })).toBeVisible();
  });

  test('MC section shows Run forecast CTA when no simulation result', async ({ page }) => {
    await expect(page.getByRole('region', { name: /monte carlo forecast/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /run forecast/i })).toBeVisible();
  });

  // #506: at the lg+ breakpoint the KPI strip switches to 6 columns so each card
  // collapses to ~150–180px. A long milestone name (or any long text value) used
  // to clip mid-word. Container-query fluid type + `break-words` should now keep
  // the visible text fully contained in the card. Uses the same reload-after-route
  // pattern as the 'error state' test so it benefits from setupRoutes priming.
  test('stat card values do not clip horizontally at 1024px with long text (#506)', async ({ page }) => {
    // Auth/membership stubs scoped to this test — prevent the session-expired
    // race (any unhandled 401 → token-refresh-on-second-401 → expireSession()
    // overlays the page with a dialog). The default setupRoutes() doesn't stub
    // these because most tests don't actually need the data to load before they
    // assert, but our visual-clipping assertion does.
    await page.route('**/api/v1/auth/me/', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'e2e-user',
          email: 'e2e@trueppm.local',
          username: 'e2e',
          first_name: 'E2E',
          last_name: 'User',
          is_active: true,
        }),
      }),
    );
    await page.route('**/api/v1/auth/token/refresh/', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ access: 'e2e-token-refreshed' }),
      }),
    );
    await page.route('**/api/v1/programs/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
      }),
    );
    await page.route('**/api/v1/me/work/', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ tasks: [] }),
      }),
    );
    await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(FIXTURE_PROJECTS[0]),
      }),
    );
    await page.route(`**/api/v1/projects/${PROJECT_ID}/members/**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
      }),
    );

    await page.unroute(`**/api/v1/projects/${PROJECT_ID}/overview/`);
    await page.route(`**/api/v1/projects/${PROJECT_ID}/overview/`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...FIXTURE_OVERVIEW,
          next_milestone: {
            id: 'm1',
            name: 'Production Launch Phase 2',
            date: '2026-05-01',
            percent_complete: 0,
          },
        }),
      }),
    );
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.reload();

    const milestoneValue = page.getByText('Production Launch Phase 2');
    await expect(milestoneValue).toBeVisible({ timeout: 10_000 });

    // overflow-hidden + break-words means the visible text fully fits — scrollWidth
    // should not exceed clientWidth (allow 1px for sub-pixel rendering).
    const overflowPx = await milestoneValue.evaluate(
      (el) => (el as HTMLElement).scrollWidth - (el as HTMLElement).clientWidth,
    );
    expect(overflowPx).toBeLessThanOrEqual(1);
  });
});
