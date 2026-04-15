import { test, expect } from '@playwright/test';

/**
 * Gantt view E2E tests — toolbar, task list panel, and accessibility basics.
 *
 * The app makes real API calls; we intercept them with Playwright route mocking
 * and navigate to /?project=<fixture-id> so useGanttTasks fires the queries.
 * Auth state is seeded in localStorage before each test so RequireAuth passes.
 */

const FIXTURE_PROJECT_ID = 'e2e-fixture-00000000-0000-0000-0000-000000000001';

/** Minimal API-format projects matching what useProjects expects. */
const FIXTURE_API_PROJECTS = [
  { id: FIXTURE_PROJECT_ID, name: 'Alpha Platform Upgrade', description: '', start_date: '2026-01-01', calendar: 'default' },
];

/** Minimal API-format tasks (snake_case) matching TaskSerializer output. */
const FIXTURE_API_TASKS = [
  {
    id: 't1', wbs_path: '1', name: 'Alpha Platform Upgrade',
    early_start: '2026-10-05', early_finish: '2026-11-14',
    duration: 30, percent_complete: 40, is_critical: false, is_milestone: false,
  },
  {
    id: 't2', wbs_path: '1.1', name: 'Discovery & Design',
    early_start: '2026-10-05', early_finish: '2026-10-16',
    duration: 10, percent_complete: 100, is_critical: true, is_milestone: false,
  },
  {
    id: 't3', wbs_path: '1.2', name: 'Backend Implementation',
    early_start: '2026-10-19', early_finish: '2026-10-30',
    duration: 10, percent_complete: 60, is_critical: true, is_milestone: false,
  },
  {
    id: 't4', wbs_path: '1.3', name: 'Frontend Implementation',
    early_start: '2026-10-19', early_finish: '2026-11-06',
    duration: 15, percent_complete: 30, is_critical: false, is_milestone: false,
  },
  {
    id: 't5', wbs_path: '1.4', name: 'Go-Live Milestone',
    early_start: '2026-11-14', early_finish: '2026-11-14',
    duration: 0, percent_complete: 0, is_critical: true, is_milestone: true,
  },
];

/** Set up API route interception and navigate to the project Gantt. */
async function gotoGantt(page: import('@playwright/test').Page) {
  // Seed auth state so RequireAuth lets the test through.
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });
  await page.route('**/api/v1/projects/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: FIXTURE_API_PROJECTS.length, next: null, previous: null, results: FIXTURE_API_PROJECTS }) }),
  );
  // Must register AFTER the projects catchall — Playwright matches routes in reverse
  // registration order, so the specific presence handler takes precedence.
  await page.route('**/api/v1/projects/*/presence/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  await page.route('**/api/v1/tasks/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: FIXTURE_API_TASKS.length, next: null, previous: null, results: FIXTURE_API_TASKS }) }),
  );
  await page.route('**/api/v1/dependencies/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }) }),
  );
  await page.goto(`/gantt?project=${FIXTURE_PROJECT_ID}`);
}

test.describe('GanttView toolbar', () => {
  test.beforeEach(async ({ page }) => {
    await gotoGantt(page);
    // Wait for the Gantt to finish loading (task list should be visible)
    await expect(
      page.getByRole('grid', { name: 'Task list' }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('view-mode switcher has Gantt active; WBS and Table are present', async ({ page }) => {
    // ViewTabs renders as <nav aria-label="View"> with <Link> children (role="link").
    // Active state is indicated by aria-current="page" (not aria-pressed).
    const nav = page.getByRole('navigation', { name: 'View' });
    await expect(nav).toBeVisible();

    const ganttLink = nav.getByRole('link', { name: 'Gantt' });
    const wbsLink = nav.getByRole('link', { name: 'WBS' });
    const tableLink = nav.getByRole('link', { name: 'Table' });

    await expect(ganttLink).toBeVisible();
    await expect(ganttLink).toHaveAttribute('aria-current', 'page');

    await expect(wbsLink).toBeVisible();
    await expect(wbsLink).not.toHaveAttribute('aria-current', 'page');

    await expect(tableLink).toBeVisible();
    await expect(tableLink).not.toHaveAttribute('aria-current', 'page');
  });

  test('switching to WBS view shows the treegrid', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: 'View' });
    await nav.getByRole('link', { name: 'WBS' }).click();
    await expect(page).toHaveURL(/[?&]view=wbs/);
    await expect(page.getByRole('treegrid', { name: 'WBS task tree' })).toBeVisible();
  });

  test('switching to Table view shows the task grid', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: 'View' });
    await nav.getByRole('link', { name: 'Table' }).click();
    await expect(page).toHaveURL(/[?&]view=list/);
    await expect(page.getByRole('grid', { name: 'Task list' })).toBeVisible();
  });

  test('Today button is present and focusable', async ({ page }) => {
    const todayBtn = page.getByRole('button', { name: 'Today' });
    await expect(todayBtn).toBeVisible();
    await todayBtn.focus();
    await expect(todayBtn).toBeFocused();
  });
});

test.describe('GanttView task list', () => {
  test.beforeEach(async ({ page }) => {
    await gotoGantt(page);
    await expect(
      page.getByRole('grid', { name: 'Task list' }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('task list header shows Dur · Start column', async ({ page }) => {
    const header = page.getByRole('row', { name: 'Task list columns' });
    await expect(header).toBeVisible();
    await expect(header.getByRole('columnheader', { name: 'Duration and start date' })).toBeVisible();
  });

  test('critical path tasks are announced accessibly', async ({ page }) => {
    // At least one task should have "(critical path)" in its aria-label
    const criticalCell = page.locator('[aria-label*="critical path"]').first();
    await expect(criticalCell).toBeVisible();
  });
});

test.describe('Accessibility basics', () => {
  test.beforeEach(async ({ page }) => {
    await gotoGantt(page);
  });

  test('sidebar has accessible label', async ({ page }) => {
    await expect(page.getByRole('complementary', { name: 'Projects' })).toBeVisible();
  });

  test('status bar is a contentinfo landmark', async ({ page }) => {
    await expect(
      page.getByRole('contentinfo', { name: 'Project status' }),
    ).toBeVisible();
  });

  test('Gantt legend lists Complete, In progress, Critical path, Milestone', async ({
    page,
  }) => {
    const legend = page.getByLabel('Gantt legend');
    await expect(legend).toBeVisible();
    for (const label of ['Complete', 'In progress', 'Critical path', 'Milestone']) {
      await expect(legend.getByText(label)).toBeVisible();
    }
  });
});
