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
    is_milestone: false, status: 'DONE',
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
  await page.route('**/api/v1/projects/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: FIXTURE_PROJECTS.length, next: null, previous: null, results: FIXTURE_PROJECTS }),
    }),
  );
  await page.route('**/api/v1/projects/*/presence/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
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
}

test.describe('View switching', () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
    await page.goto(`/gantt?project=${FIXTURE_PROJECT_ID}`);
    // Wait for the Gantt to be ready before switching views.
    await expect(page.getByRole('grid', { name: 'Task list' })).toBeVisible({ timeout: 10_000 });
  });

  test('Gantt view is active by default and URL reflects it', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: 'View' });
    await expect(nav.getByRole('link', { name: 'Gantt' })).toHaveAttribute('aria-current', 'page');
    // URL should not include view=wbs/list/board when on Gantt.
    expect(page.url()).not.toMatch(/view=(wbs|list|board)/);
  });

  test('navigate to WBS — treegrid renders and URL updates', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: 'View' });
    await nav.getByRole('link', { name: 'WBS' }).click();
    await expect(page).toHaveURL(/[?&]view=wbs/);
    await expect(page.getByRole('treegrid', { name: 'WBS task tree' })).toBeVisible();
  });

  test('navigate to Board — columns render and URL updates', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: 'View' });
    await nav.getByRole('link', { name: 'Board' }).click();
    await expect(page).toHaveURL(/[?&]view=board/);
    // Board renders columns; at least TO DO column should be visible.
    await expect(page.locator('[aria-label*="TO DO"]').first()).toBeVisible({ timeout: 5_000 });
  });

  test('navigate to Table — task grid renders and URL updates', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: 'View' });
    await nav.getByRole('link', { name: 'Table' }).click();
    await expect(page).toHaveURL(/[?&]view=list/);
    await expect(page.getByRole('grid', { name: 'Task list' })).toBeVisible();
  });

  test('round-trip Gantt → WBS → Board → Table → Gantt', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: 'View' });

    await nav.getByRole('link', { name: 'WBS' }).click();
    await expect(page.getByRole('treegrid', { name: 'WBS task tree' })).toBeVisible();

    await nav.getByRole('link', { name: 'Board' }).click();
    await expect(page.locator('[aria-label*="TO DO"]').first()).toBeVisible({ timeout: 5_000 });

    await nav.getByRole('link', { name: 'Table' }).click();
    await expect(page.getByRole('grid', { name: 'Task list' })).toBeVisible();

    await nav.getByRole('link', { name: 'Gantt' }).click();
    await expect(page).not.toHaveURL(/view=(wbs|list|board)/);
    await expect(page.getByRole('grid', { name: 'Task list' })).toBeVisible();
  });

  test('deep-link to WBS view renders without visiting Gantt first', async ({ page }) => {
    // Navigate directly to ?view=wbs — must render without round-tripping through Gantt.
    await page.goto(`/gantt?project=${FIXTURE_PROJECT_ID}&view=wbs`);
    await expect(page.getByRole('treegrid', { name: 'WBS task tree' })).toBeVisible({ timeout: 10_000 });
  });
});
