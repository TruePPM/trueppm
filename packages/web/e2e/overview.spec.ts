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

  await page.route('**/api/v1/projects/*/presence/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
}

test.describe('Project overview page', () => {
  test.beforeEach(async ({ page }) => {
    await setupRoutes(page);
    await page.goto(`/projects/${PROJECT_ID}/overview`);
    // Wait for the KPI section to appear
    await expect(page.getByRole('region', { name: /project kpis/i })).toBeVisible({ timeout: 10_000 });
  });

  test('golden path — KPI cards, attention panel, and my-tasks all render', async ({ page }) => {
    // KPI card labels
    await expect(page.getByText(/schedule health/i)).toBeVisible();
    await expect(page.getByText(/late tasks/i)).toBeVisible();
    await expect(page.getByText(/next milestone/i)).toBeVisible();

    // Loaded KPI values
    await expect(page.getByText('On track')).toBeVisible();
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

  test('navigate to Gantt view from overview', async ({ page }) => {
    // Stub task and dependency routes for Gantt
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

    const nav = page.getByRole('navigation', { name: 'View' });
    await nav.getByRole('link', { name: 'Gantt' }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/gantt`));
    await expect(nav.getByRole('link', { name: 'Gantt' })).toHaveAttribute('aria-current', 'page');
  });

  test('error state — overview API 500 does not crash the page', async ({ page }) => {
    // Intercept to return 500 for this test only (page already loaded; navigate fresh)
    await page.route(`**/api/v1/projects/${PROJECT_ID}/overview/`, (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }),
    );
    await page.reload();
    // Page should still render — KPI section exists even if data is empty
    await expect(page.getByRole('region', { name: /project kpis/i })).toBeVisible({ timeout: 10_000 });
  });
});
