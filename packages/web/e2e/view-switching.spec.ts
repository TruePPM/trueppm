import { test, expect } from '@playwright/test';

/**
 * View-switching E2E flows — navigate between Gantt, WBS, Table, and Board views.
 *
 * Extends the view-mode switching covered in gantt.spec.ts with:
 * - Board view navigation and column rendering
 * - Round-trip switching (Gantt → WBS → Board → Table → Gantt)
 * - URL reflects the active view so deep links work
 *
 * These run against the production build with intercepted API routes.
 */

const FIXTURE_PROJECT_ID = 'e2e-view-00000000-0000-0000-0000-000000000002';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}`;

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'View Switching Project',
    description: '',
    start_date: '2026-01-01',
    calendar: 'default',
  },
];

const FIXTURE_TASKS = [
  {
    id: 'v1', wbs_path: '1', name: 'Phase 1',
    early_start: '2026-01-05', early_finish: '2026-01-16',
    duration: 10, percent_complete: 50, is_critical: false,
    is_milestone: false, status: 'IN_PROGRESS',
  },
  {
    id: 'v2', wbs_path: '1.1', name: 'Design',
    early_start: '2026-01-05', early_finish: '2026-01-09',
    duration: 5, percent_complete: 100, is_critical: false,
    is_milestone: false, status: 'COMPLETE',
  },
  {
    id: 'v3', wbs_path: '1.2', name: 'Build',
    early_start: '2026-01-12', early_finish: '2026-01-16',
    duration: 5, percent_complete: 0, is_critical: false,
    is_milestone: false, status: 'NOT_STARTED',
  },
];

async function setup(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });
  await page.route('**/api/v1/projects/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: FIXTURE_PROJECTS.length, next: null, previous: null, results: FIXTURE_PROJECTS }),
    }),
  );
  // Overview endpoints — stub with minimal data so ProjectOverviewPage doesn't error
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/overview/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ schedule_health: 'unknown', spi: null, tasks_late_count: 0, critical_task_count: 0, total_tasks: 0, complete_tasks: 0, next_milestone: null, team_utilization_pct: null }),
    }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/attention/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/my-tasks/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tasks: [] }) }),
  );
  await page.route('**/api/v1/projects/*/presence/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  await page.route('**/api/v1/projects/*/status-summary/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        task_count: 3,
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
  await page.route('**/api/v1/tasks/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: FIXTURE_TASKS.length, next: null, previous: null, results: FIXTURE_TASKS }),
    }),
  );
  await page.route('**/api/v1/dependencies/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
  // Board config — 5-column default (issue #178)
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/board-config/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        columns: [
          { status: 'BACKLOG',     label: 'Backlog',     visible: true },
          { status: 'NOT_STARTED', label: 'To Do',       visible: true },
          { status: 'IN_PROGRESS', label: 'In Progress', visible: true },
          { status: 'REVIEW',      label: 'Review',      visible: true },
          { status: 'COMPLETE',    label: 'Done',        visible: true },
        ],
      }),
    }),
  );
}

test.describe('View switching', () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
    // Start on Gantt — path-based routing (ADR-0030)
    await page.goto(`${BASE_URL}/gantt`);
    // Wait for the Gantt to be ready before switching views.
    await expect(page.getByRole('grid', { name: 'Task list' })).toBeVisible({ timeout: 10_000 });
  });

  test('Schedule tab is active when on /gantt URL and URL reflects it', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: 'View' });
    await expect(nav.getByRole('link', { name: 'Schedule' })).toHaveAttribute('aria-current', 'page');
    expect(page.url()).toMatch(/\/gantt$/);
  });

  test('navigate to WBS — treegrid renders and URL updates', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: 'View' });
    await nav.getByRole('link', { name: 'WBS' }).click();
    await expect(page).toHaveURL(/\/wbs$/);
    await expect(page.getByRole('treegrid', { name: 'WBS task tree' })).toBeVisible();
  });

  test('navigate to Board — columns render and URL updates', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: 'View' });
    await nav.getByRole('link', { name: 'Board' }).click();
    await expect(page).toHaveURL(/\/board$/);
    // Board renders columns; at least the "To Do" column should be visible.
    await expect(page.locator('[aria-label*="To Do"]').first()).toBeVisible({ timeout: 5_000 });
  });

  test('navigate to Table — task grid renders and URL updates', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: 'View' });
    await nav.getByRole('link', { name: 'Table' }).click();
    await expect(page).toHaveURL(/\/list$/);
    await expect(page.getByRole('grid', { name: 'Task list' })).toBeVisible();
  });

  test('round-trip Gantt → WBS → Board → Table → Gantt', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: 'View' });

    await nav.getByRole('link', { name: 'WBS' }).click();
    await expect(page.getByRole('treegrid', { name: 'WBS task tree' })).toBeVisible();

    await nav.getByRole('link', { name: 'Board' }).click();
    await expect(page.locator('[aria-label*="To Do"]').first()).toBeVisible({ timeout: 5_000 });

    await nav.getByRole('link', { name: 'Table' }).click();
    await expect(page.getByRole('grid', { name: 'Task list' })).toBeVisible();

    await nav.getByRole('link', { name: 'Schedule' }).click();
    await expect(page).toHaveURL(/\/gantt$/);
    await expect(page.getByRole('grid', { name: 'Task list' })).toBeVisible();
  });

  test('deep-link to WBS view renders without visiting Gantt first', async ({ page }) => {
    // Navigate directly to /wbs path — must render without round-tripping through Gantt.
    await page.goto(`${BASE_URL}/wbs`);
    await expect(page.getByRole('treegrid', { name: 'WBS task tree' })).toBeVisible({ timeout: 10_000 });
  });

  test('navigating to /projects/:id with no view segment redirects to Board (issue #204)', async ({ page }) => {
    // React Router index route: <Navigate to="board" replace /> — must redirect immediately.
    await page.goto(BASE_URL);
    await expect(page).toHaveURL(/\/board$/, { timeout: 5_000 });
    await expect(page.getByRole('navigation', { name: 'View' }).getByRole('link', { name: 'Board' }))
      .toHaveAttribute('aria-current', 'page');
  });

  test('Board tab is first and Schedule is second in the tab strip (issue #204)', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: 'View' });
    const links = nav.getByRole('link');
    await expect(links.nth(0)).toHaveText('Board');
    await expect(links.nth(1)).toHaveText('Schedule');
  });
});
