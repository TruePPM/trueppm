import { test, expect } from '@playwright/test';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * Wave 1 — TopBar health cluster (issue #205, updated for the v2 methodology-adaptive
 * health cluster — ADR-0128 / #1167).
 *
 * The fixture project resolves to HYBRID in this harness, so the cluster shows the
 * Sprint · Forecast · Critical trio. The WATERFALL trio (Forecast · At-risk · Critical)
 * and the AGILE trio (Sprint · Points · Velocity) — including the velocity privacy
 * wall — are covered deterministically in the HealthCluster.test.tsx vitest spec.
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
  critical_tasks: [{ id: 'cr1', wbs: '2.1', name: 'Database Migration' }],
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

  // Catch-all 401-guard FIRST (last-registered-wins): the project shell + ⌘K
  // palette read endpoints this spec does not mock (notifications, ws ticket,
  // calendars, …) which would otherwise fall through to the real backend and
  // 401 into the session-expired modal mid-test (issue 1572 / #1190 class).
  await setupCatchAll(page);
  await page.route('**/api/v1/projects/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 1, next: null, previous: null, results: FIXTURE_PROJECTS }),
    }),
  );
  // The cluster mounts useActiveSprint + useProjectVelocity unconditionally; stub
  // them empty so the cluster doesn't hit the live network for unused data (and the
  // HYBRID Sprint segment reads "No active Sprint").
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/sprints/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/velocity/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sprints: [],
        rolling_avg_points: null,
        rolling_stdev_points: null,
        forecast_range_low: null,
        forecast_range_high: null,
        rolling_avg_tasks: null,
        rolling_stdev_tasks: null,
        team_velocity_per_day: null,
        excluded_count: 0,
      }),
    }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/overview/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        schedule_health: 'at_risk',
        spi: 0.92,
        tasks_late_count: 2,
        critical_task_count: 1,
        total_tasks: 5,
        complete_tasks: 2,
        next_milestone: null,
        team_utilization_pct: null,
        owner_name: null,
        start_date: '2026-01-01',
      }),
    }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/attention/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [] }),
    }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/my-tasks/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ tasks: [] }),
    }),
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
  await page.route('**/api/v1/projects/*/monte-carlo/latest/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        project_id: FIXTURE_PROJECT_ID,
        runs: 1000,
        p50: '2026-10-20',
        p80: '2026-11-03',
        p95: '2026-11-17',
        histogram_buckets: [
          { date: '2026-10-13', count: 50 },
          { date: '2026-10-20', count: 200 },
          { date: '2026-10-27', count: 350 },
          { date: '2026-11-03', count: 250 },
          { date: '2026-11-10', count: 100 },
          { date: '2026-11-17', count: 50 },
        ],
      }),
    }),
  );
}

test.describe('Wave 1 — TopBar health cluster (desktop, lg+ viewport)', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test.beforeEach(async ({ page }) => {
    await setupBase(page, HEALTH_STATUS_SUMMARY);
    await page.goto(`${BASE_URL}/overview`);
  });

  test('the bordered health cluster renders', async ({ page }) => {
    await expect(page.getByTestId('health-cluster')).toBeVisible();
  });

  test('Forecast segment renders the P50·P80 band with month-day dates (#1197)', async ({
    page,
  }) => {
    const forecastBtn = page.getByRole('button', { name: /monte carlo forecast/i });
    await expect(forecastBtn).toBeVisible();
    await expect(forecastBtn).toContainText('P50');
    await expect(forecastBtn).toContainText('Oct'); // P50 = 2026-10-20
    await expect(forecastBtn).toContainText('P80');
    await expect(forecastBtn).toContainText('Nov'); // P80 = 2026-11-03
  });

  test('clicking Forecast segment opens MC distribution panel', async ({ page }) => {
    await page.getByRole('button', { name: /monte carlo forecast/i }).click();
    await expect(
      page.getByRole('dialog', { name: /monte carlo confidence/i }),
    ).toBeVisible();
  });

  test('critical segment renders count from status-summary', async ({ page }) => {
    await expect(page.getByRole('button', { name: /1 critical task/i })).toBeVisible();
  });

  test('clicking critical segment opens popover with task items', async ({ page }) => {
    await page.getByRole('button', { name: /1 critical task/i }).click();
    const menu = page.getByRole('menu', { name: /1 critical task/i });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /database migration/i })).toBeVisible();
  });

  test('Sprint segment reads "No active Sprint" when there is no active sprint', async ({
    page,
  }) => {
    const cluster = page.getByTestId('health-cluster');
    await expect(cluster.getByText(/no active sprint/i)).toBeVisible();
  });

  test('cluster shows calm zero/— reads (no actionable buttons) when there are no signals', async ({
    page,
  }) => {
    // The v2 cluster has fixed slots (ADR-0128) — it does not vanish; each segment
    // renders a calm static read: P80 "—", "0 critical". None are drill-down buttons.
    await page.route('**/api/v1/projects/*/status-summary/', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(EMPTY_STATUS_SUMMARY),
      }),
    );
    // "No signals" also means no forecast has been run: a 404 from /latest/ is
    // the genuine not-run state. The forecast segment now falls back to the live
    // MC P80 when the status summary omits it (ADR-0144 "P80 —" fix), so the live
    // result must also be empty here for the segment to read "—".
    await page.route('**/api/v1/projects/*/monte-carlo/latest/', (route) =>
      route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }),
    );
    await page.reload();
    const cluster = page.getByTestId('health-cluster');
    await expect(cluster).toBeVisible();
    await expect(cluster).toContainText('—');
    await expect(page.getByRole('button', { name: /monte carlo/i })).not.toBeVisible();
    await expect(page.getByRole('button', { name: /critical task/i })).not.toBeVisible();
  });
});

test.describe('TopBar health cluster (tablet, 768–1024px — issue #1562)', () => {
  // Janet reads P80/health on a tablet before board meetings; the 768–1024px range
  // must keep the cluster expanded with the P80 forecast inline, not buried behind
  // the "Health ▾" dropdown. Width 900px sits squarely in the tablet band.
  test.use({ viewport: { width: 900, height: 1200 } });

  test.beforeEach(async ({ page }) => {
    await setupBase(page, HEALTH_STATUS_SUMMARY);
    await page.goto(`${BASE_URL}/overview`);
  });

  test('expanded cluster is visible at tablet width', async ({ page }) => {
    await expect(page.getByTestId('health-cluster')).toBeVisible();
  });

  test('P80 forecast is inline (not collapsed to the Health dropdown)', async ({ page }) => {
    const forecastBtn = page.getByRole('button', { name: /monte carlo forecast/i });
    await expect(forecastBtn).toBeVisible();
    await expect(forecastBtn).toContainText('P80');
    await expect(forecastBtn).toContainText('Nov'); // P80 = 2026-11-03
    // The phone-only collapsed dropdown must NOT be shown in the tablet band.
    await expect(
      page.getByRole('button', { name: /project health summary/i }),
    ).not.toBeVisible();
  });
});

test.describe('Wave 1 — TopBar health cluster (mobile, collapsed Health dropdown)', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test.beforeEach(async ({ page }) => {
    await setupBase(page, HEALTH_STATUS_SUMMARY);
    await page.goto(`${BASE_URL}/overview`);
  });

  test('collapsed Health button is visible on mobile', async ({ page }) => {
    await expect(page.getByRole('button', { name: /project health summary/i })).toBeVisible();
  });

  test('collapsed Health expands to show segment reads and task items on click', async ({
    page,
  }) => {
    const btn = page.getByRole('button', { name: /project health summary/i });
    await btn.click();
    await expect(btn).toHaveAttribute('aria-expanded', 'true');
    const menu = page.getByRole('menu', { name: /project health summary/i });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /database migration/i })).toBeVisible();
  });

  test('collapsed Health stays present and shows zero/— reads when there are no signals', async ({
    page,
  }) => {
    // The v2 cluster has fixed slots (ADR-0128) — its collapsed form does not vanish.
    await page.route('**/api/v1/projects/*/status-summary/', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(EMPTY_STATUS_SUMMARY),
      }),
    );
    await page.reload();
    const btn = page.getByRole('button', { name: /project health summary/i });
    await expect(btn).toBeVisible();
    await btn.click();
    const menu = page.getByRole('menu', { name: /project health summary/i });
    await expect(menu).toContainText('0 critical');
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
            { status: 'BACKLOG', label: 'Backlog', visible: true },
            { status: 'NOT_STARTED', label: 'To Do', visible: true },
            { status: 'IN_PROGRESS', label: 'In Progress', visible: true },
            { status: 'REVIEW', label: 'Review', visible: true },
            { status: 'COMPLETE', label: 'Done', visible: true },
          ],
        }),
      }),
    );
    await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/resource-allocation/**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          project_id: FIXTURE_PROJECT_ID,
          window_start: '2026-01-01',
          window_end: '2026-03-01',
          resources: [],
        }),
      }),
    );
    await page.goto(`${BASE_URL}/overview`);
  });

  test('BottomNav Schedule link navigates to path-based /schedule URL', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: 'View' });
    // Schedule is an overflow view on HYBRID (ADR-0196, issue #1464) — the rail
    // caps at 4 primary tabs + More, so Schedule is reached via the More sheet.
    await nav.getByRole('button', { name: /^More/ }).click();
    const sheet = page.getByRole('dialog');
    await sheet.getByRole('link', { name: 'Schedule' }).click();
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

  test('BottomNav exposes the headline Today view on mobile (issue #1324)', async ({ page }) => {
    // The 0.3 headline Today view (ADR-0180) must be reachable on mobile — it was
    // present in the desktop ViewTabs but absent from the BottomNav rail, leaving it
    // unreachable on any phone viewport. Assert the link exists with a path-based href.
    const nav = page.getByRole('navigation', { name: 'View' });
    const todayLink = nav.getByRole('link', { name: 'Today' });
    await expect(todayLink).toBeVisible();
    await expect(todayLink).toHaveAttribute('href', `/projects/${FIXTURE_PROJECT_ID}/today`);
  });

  test('BottomNav exposes project Settings on mobile via More and marks it active (issue #539)', async ({
    page,
  }) => {
    // Mobile users need a path to project settings without the desktop tabs.
    // Post ADR-0196 (issue #1464) Settings lives in the More overflow sheet; it
    // must stay reachable, land on the settings page, and — because the active
    // surface is overflow-parked — the More button announces it as selected.
    const nav = page.getByRole('navigation', { name: 'View' });
    await nav.getByRole('button', { name: /^More/ }).click();
    const sheet = page.getByRole('dialog');
    const settingsLink = sheet.getByRole('link', { name: 'Settings' });
    await expect(settingsLink).toHaveAttribute('href', `/projects/${FIXTURE_PROJECT_ID}/settings`);
    await settingsLink.click();
    await expect(page).toHaveURL(new RegExp(`/projects/${FIXTURE_PROJECT_ID}/settings`));
    // The sheet closes on navigation; the More button reflects the active view.
    await expect(nav.getByRole('button', { name: /More, Settings selected/i })).toBeVisible();
  });
});
