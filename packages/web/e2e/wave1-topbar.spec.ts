import { test, expect } from '@playwright/test';

/**
 * Wave 1 — TopBar health badges (issue #205).
 *
 * Covers: P80 pill, at-risk/critical BadgePopover, mobile HealthDropdown,
 * and empty-state (no badges when there are no health signals).
 */

const FIXTURE_PROJECT_ID = 'e2e-wave1-0000-0000-0000-000000000001';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}`;

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Health Badge Project',
    description: '',
    start_date: '2026-01-01',
    calendar: 'default',
  },
];

const HEALTH_STATUS_SUMMARY = {
  task_count: 5,
  critical_path_count: 1,
  monte_carlo_p80: '2026-11-03',
  at_risk_count: 2,
  critical_count: 1,
  at_risk_tasks: [
    { id: 'ar1', wbs: '1.1', name: 'Frontend Build' },
    { id: 'ar2', wbs: '1.2', name: 'Backend Implementation' },
  ],
  critical_tasks: [
    { id: 'cr1', wbs: '2.1', name: 'Database Migration' },
  ],
  last_saved: null,
  recalculated_at: null,
};

const EMPTY_STATUS_SUMMARY = {
  task_count: 3,
  critical_path_count: 0,
  monte_carlo_p80: null,
  at_risk_count: 0,
  critical_count: 0,
  at_risk_tasks: [],
  critical_tasks: [],
  last_saved: null,
  recalculated_at: null,
};

async function setupBase(page: import('@playwright/test').Page, statusSummary: object) {
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
      body: JSON.stringify({ count: 1, next: null, previous: null, results: FIXTURE_PROJECTS }),
    }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/overview/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        schedule_health: 'at_risk', spi: 0.92, tasks_late_count: 2, critical_task_count: 1,
        total_tasks: 5, complete_tasks: 2, next_milestone: null, team_utilization_pct: null,
        owner_name: null, start_date: '2026-01-01',
      }),
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
      body: JSON.stringify(statusSummary),
    }),
  );
}

test.describe('Wave 1 — TopBar health badges (desktop, lg+ viewport)', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test.beforeEach(async ({ page }) => {
    await setupBase(page, HEALTH_STATUS_SUMMARY);
    await page.goto(`${BASE_URL}/overview`);
  });

  test('P80 badge renders with month-day date when monte_carlo_p80 is set', async ({ page }) => {
    const p80Btn = page.getByRole('button', { name: /monte carlo p80/i });
    await expect(p80Btn).toBeVisible();
    await expect(p80Btn).toContainText('P80:');
    await expect(p80Btn).toContainText('Nov');
  });

  test('clicking P80 badge opens MC distribution panel', async ({ page }) => {
    await page.getByRole('button', { name: /monte carlo p80/i }).click();
    await expect(page.getByRole('dialog', { name: /monte carlo confidence distribution/i })).toBeVisible();
  });

  test('at-risk badge renders count from status-summary', async ({ page }) => {
    await expect(page.getByRole('button', { name: /2 at risk tasks/i })).toBeVisible();
  });

  test('clicking at-risk badge opens popover with task items', async ({ page }) => {
    await page.getByRole('button', { name: /2 at risk tasks/i }).click();
    const menu = page.getByRole('menu', { name: /2 at risk tasks/i });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /frontend build/i })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /backend implementation/i })).toBeVisible();
  });

  test('critical badge renders count from status-summary', async ({ page }) => {
    await expect(page.getByRole('button', { name: /1 critical tasks/i })).toBeVisible();
  });

  test('clicking critical badge opens popover with task items', async ({ page }) => {
    await page.getByRole('button', { name: /1 critical tasks/i }).click();
    const menu = page.getByRole('menu', { name: /1 critical tasks/i });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /database migration/i })).toBeVisible();
  });

  test('no health badges render when status-summary has no signals', async ({ page }) => {
    // Re-stub with empty summary and reload
    await page.route('**/api/v1/projects/*/status-summary/', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(EMPTY_STATUS_SUMMARY),
      }),
    );
    await page.reload();
    await expect(page.getByRole('button', { name: /monte carlo p80/i })).not.toBeVisible();
    await expect(page.getByRole('button', { name: /at risk tasks/i })).not.toBeVisible();
    await expect(page.getByRole('button', { name: /critical tasks/i })).not.toBeVisible();
  });
});

test.describe('Wave 1 — TopBar health badges (mobile, collapsed HealthDropdown)', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test.beforeEach(async ({ page }) => {
    await setupBase(page, HEALTH_STATUS_SUMMARY);
    await page.goto(`${BASE_URL}/overview`);
  });

  test('HealthDropdown button is visible on mobile', async ({ page }) => {
    await expect(page.getByRole('button', { name: /project health summary/i })).toBeVisible();
  });

  test('HealthDropdown expands to show P80 and task items on click', async ({ page }) => {
    const btn = page.getByRole('button', { name: /project health summary/i });
    await btn.click();
    await expect(btn).toHaveAttribute('aria-expanded', 'true');
    const menu = page.getByRole('menu', { name: /project health summary/i });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /frontend build/i })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /database migration/i })).toBeVisible();
  });

  test('HealthDropdown is absent when there are no health signals', async ({ page }) => {
    await page.route('**/api/v1/projects/*/status-summary/', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(EMPTY_STATUS_SUMMARY),
      }),
    );
    await page.reload();
    await expect(page.getByRole('button', { name: /project health summary/i })).not.toBeVisible();
  });
});

test.describe('Wave 1 — BottomNav path-based routing (issue #250)', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test.beforeEach(async ({ page }) => {
    await setupBase(page, EMPTY_STATUS_SUMMARY);
    await page.route(`**/api/v1/tasks/**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
      }),
    );
    await page.route(`**/api/v1/dependencies/**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
      }),
    );
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
    await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/resource-allocation/**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ project_id: FIXTURE_PROJECT_ID, window_start: '2026-01-01', window_end: '2026-03-01', resources: [] }),
      }),
    );
    await page.goto(`${BASE_URL}/overview`);
  });

  test('BottomNav Schedule link navigates to path-based /schedule URL', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: 'View' });
    await nav.getByRole('link', { name: 'Schedule' }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${FIXTURE_PROJECT_ID}/schedule$`));
  });

  test('BottomNav Board link has path-based href (not query-param)', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: 'View' });
    const boardLink = nav.getByRole('link', { name: 'Board' });
    await expect(boardLink).toHaveAttribute('href', `/projects/${FIXTURE_PROJECT_ID}/board`);
  });

  test('active tab in BottomNav reflects the current path', async ({ page }) => {
    await page.goto(`${BASE_URL}/board`);
    const nav = page.getByRole('navigation', { name: 'View' });
    await expect(nav.getByRole('link', { name: 'Board' })).toHaveAttribute('aria-current', 'page');
    await expect(nav.getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current');
  });
});
