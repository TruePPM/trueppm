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

// The v2 methodology cluster is now a single all-width status chip + health
// popover (issue #1644 — progressive disclosure). The always-inline segmented
// cluster and the phone-only "Health ▾" dropdown are gone: the chip is one
// control at every width, and its rows (forecast band, at-risk/critical drills,
// sprint/points/velocity) live inside the popover the chip opens. The fixture
// project resolves to HYBRID, so the popover shows Sprint · Forecast · Critical.

/** Open the health popover from the status chip and return the dialog locator. */
async function openHealthPopover(page: import('@playwright/test').Page) {
  await page.getByTestId('health-cluster').click();
  const dialog = page.getByRole('dialog', { name: 'Project health' });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe('Wave 1 — TopBar health chip + popover (desktop)', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test.beforeEach(async ({ page }) => {
    await setupBase(page, HEALTH_STATUS_SUMMARY);
    await page.goto(`${BASE_URL}/overview`);
  });

  test('the status chip renders with the worst-state word and P80 fragment', async ({ page }) => {
    const chip = page.getByTestId('health-cluster');
    await expect(chip).toBeVisible();
    // critical_count = 1 → "At risk"; monte_carlo_p80 = 2026-11-03 → "Nov 3".
    await expect(chip).toContainText('At risk');
    await expect(chip).toContainText('P80');
    await expect(chip).toContainText('Nov 3');
    await expect(chip).toHaveAttribute('aria-haspopup', 'dialog');
  });

  test('the chip opens the health popover with the forecast P50·P80 band (#1197)', async ({
    page,
  }) => {
    const dialog = await openHealthPopover(page);
    await expect(dialog.getByText('Forecast P50')).toBeVisible();
    await expect(dialog.getByText('Forecast P80')).toBeVisible();
    await expect(dialog).toContainText('Oct'); // P50 = 2026-10-20
    await expect(dialog).toContainText('Nov'); // P80 = 2026-11-03
  });

  test('the forecast "Details ›" row opens the MC distribution panel', async ({ page }) => {
    const dialog = await openHealthPopover(page);
    await dialog.getByRole('button', { name: /monte carlo forecast/i }).click();
    await expect(page.getByRole('dialog', { name: /monte carlo confidence/i })).toBeVisible();
  });

  test('the critical row drills the offending task and closes the popover', async ({ page }) => {
    const dialog = await openHealthPopover(page);
    // HYBRID cluster's critical row (count 1) lists the offending task.
    const taskBtn = dialog.getByRole('button', { name: /database migration/i });
    await expect(taskBtn).toBeVisible();
    await taskBtn.click();
    // Drilling closes the popover (the task navigation is owned by TopBar).
    await expect(page.getByRole('dialog', { name: 'Project health' })).toBeHidden();
  });

  test('the popover reads "No active Sprint" when there is no active sprint', async ({ page }) => {
    const dialog = await openHealthPopover(page);
    await expect(dialog.getByText(/no active sprint/i)).toBeVisible();
  });

  test('Escape closes the popover and returns focus to the chip', async ({ page }) => {
    const chip = page.getByTestId('health-cluster');
    await openHealthPopover(page);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Project health' })).toBeHidden();
    await expect(chip).toBeFocused();
  });

  test('the chip reads "On track" with calm zero/— rows when there are no signals', async ({
    page,
  }) => {
    await page.route('**/api/v1/projects/*/status-summary/', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(EMPTY_STATUS_SUMMARY),
      }),
    );
    // No forecast run: a 404 from /latest/ is the genuine not-run state (the
    // forecast segment falls back to the live MC P80 otherwise — ADR-0144).
    await page.route('**/api/v1/projects/*/monte-carlo/latest/', (route) =>
      route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }),
    );
    await page.reload();
    const chip = page.getByTestId('health-cluster');
    await expect(chip).toContainText('On track');
    const dialog = await openHealthPopover(page);
    await expect(dialog).toContainText('0 tasks'); // "Critical path — 0 tasks"
    await expect(dialog).toContainText('—'); // "Forecast P80 —"
    // With no MC result cached there is no Details drill.
    await expect(dialog.getByRole('button', { name: /monte carlo/i })).toHaveCount(0);
  });

  test('the chip is suppressed on a project settings route (rule 123 / ADR-0128 §C)', async ({
    page,
  }) => {
    await page.goto(`${BASE_URL}/settings/general`);
    await expect(page.getByTestId('health-cluster')).toHaveCount(0);
  });
});

test.describe('TopBar health chip (mobile — all-width, no dropdown)', () => {
  // The chip is one all-width control at every viewport (issue #1644): the old
  // phone-only "Health ▾" dropdown is gone. The P80 fragment may drop below the
  // sm breakpoint, but the dot + state word are always shown, and the popover
  // still opens.
  test.use({ viewport: { width: 375, height: 812 } });

  test.beforeEach(async ({ page }) => {
    await setupBase(page, HEALTH_STATUS_SUMMARY);
    await page.goto(`${BASE_URL}/overview`);
  });

  test('the status chip is visible on a phone and shows the state word', async ({ page }) => {
    const chip = page.getByTestId('health-cluster');
    await expect(chip).toBeVisible();
    await expect(chip).toContainText('At risk');
    // The removed phone-only "Health ▾" dropdown must not exist.
    await expect(page.getByRole('button', { name: /project health summary/i })).toHaveCount(0);
  });

  test('the chip still opens the health popover on a phone', async ({ page }) => {
    const dialog = await openHealthPopover(page);
    await expect(dialog.getByRole('button', { name: /database migration/i })).toBeVisible();
  });

  test('the health popover stays fully within the viewport on a phone (#1969)', async ({
    page,
  }) => {
    const dialog = await openHealthPopover(page);
    // The popover is portaled + fixed and clamped to the viewport (rule 253); it
    // previously grew leftward from a mid-bar chip and clipped off the left edge.
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(375);
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
