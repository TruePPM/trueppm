import { test, expect } from '@playwright/test';

/**
 * Monte Carlo integration tests for the Schedule view — issue #333, consolidated
 * onto the single ScheduleForecastBar by ADR-0144 / #1231 (web rule 189).
 *
 * Covers:
 * - P50/P80/P95 markers visible on the Gantt timeline
 * - The consolidated bar shows the P80 chip with its delta vs CPM finish — once
 * - Recomputing indicator appears when Rerun is clicked
 * - Details panel opens on the Details button
 * - The bar expands to the histogram + sensitivity tornado
 * - The percentiles render on exactly one surface (no two-surface double-claim)
 */

const PROJECT_ID = 'e2e-mc-00000000-0000-0000-0000-000000000099';

const FIXTURE_PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'MC Test Project',
    description: '',
    start_date: '2026-09-01',
    calendar: 'default',
  },
];

const FIXTURE_TASKS = [
  {
    id: 'mc-t1',
    wbs_path: '1',
    name: 'Phase 1',
    early_start: '2026-09-01',
    early_finish: '2026-11-30',
    planned_start: '2026-09-01',
    duration: 60,
    percent_complete: 0,
    is_critical: true,
    is_milestone: false,
    is_summary: true,
    optimistic_duration: null,
    pessimistic_duration: null,
    most_likely_duration: null,
    notes: '',
    server_version: 1,
  },
  {
    id: 'mc-t2',
    wbs_path: '1.1',
    name: 'Backend API',
    early_start: '2026-09-01',
    early_finish: '2026-10-20',
    planned_start: '2026-09-01',
    duration: 50,
    percent_complete: 0,
    is_critical: true,
    is_milestone: false,
    is_summary: false,
    optimistic_duration: 40,
    pessimistic_duration: 65,
    most_likely_duration: 50,
    notes: '',
    server_version: 1,
  },
];

/** CPM finish = max(task.finish) for non-milestones = '2026-11-30' */

const FIXTURE_MC_RESULT = {
  project_id: PROJECT_ID,
  runs: 500,
  p50: '2026-11-15',
  p80: '2026-12-10',
  p95: '2026-12-28',
  histogram_buckets: [
    { date: '2026-10-26', count: 50 },
    { date: '2026-11-02', count: 90 },
    { date: '2026-11-09', count: 120 },
    { date: '2026-11-16', count: 100 },
    { date: '2026-11-23', count: 70 },
    { date: '2026-11-30', count: 45 },
    { date: '2026-12-07', count: 18 },
    { date: '2026-12-14', count: 7 },
  ],
  last_run_at: '2026-05-09T10:00:00Z',
  // Server-computed risk fields (#987). cpm_finish = '2026-11-30' → P80
  // (2026-12-10) is +10d. confidence_curve is the cumulative share of the
  // buckets above (500 runs), which the panel renders directly.
  cpm_finish: '2026-11-30',
  delta_vs_cpm: { p50: -15, p80: 10, p95: 28 },
  confidence_curve: [
    { date: '2026-10-26', pct: 10 },
    { date: '2026-11-02', pct: 28 },
    { date: '2026-11-09', pct: 52 },
    { date: '2026-11-16', pct: 72 },
    { date: '2026-11-23', pct: 86 },
    { date: '2026-11-30', pct: 95 },
    { date: '2026-12-07', pct: 98.6 },
    { date: '2026-12-14', pct: 100 },
  ],
  // Duration-sensitivity tornado (ADR-0140) — Backend API drives the finish.
  sensitivity: [{ task_id: 'mc-t2', index: 0.88 }],
};

/** Forecast run history (ADR-0109, #961): newest-first with per-run deltas. */
const FIXTURE_MC_HISTORY = {
  results: [
    {
      id: 'run-2',
      taken_at: '2026-05-09T10:00:00Z',
      p50: '2026-11-15',
      p80: '2026-12-10',
      p95: '2026-12-28',
      cpm_finish: '2026-11-30',
      n_simulations: 500,
      task_count: 2,
      delta: { p50: 5, p80: 14, p95: 9 },
      triggered_by_name: 'P M',
    },
    {
      id: 'run-1',
      taken_at: '2026-05-02T10:00:00Z',
      p50: '2026-11-10',
      p80: '2026-11-26',
      p95: '2026-12-19',
      cpm_finish: '2026-11-30',
      n_simulations: 500,
      task_count: 2,
      delta: null,
      triggered_by_name: 'P M',
    },
  ],
  cap: 100,
};

async function gotoScheduleWithMC(page: import('@playwright/test').Page) {
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
  await page.route('**/api/v1/projects/*/presence/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  await page.route('**/api/v1/projects/*/status-summary/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        task_count: 2,
        critical_path_count: 2,
        monte_carlo_p80: '2026-12-10',
        at_risk_count: 0,
        critical_count: 0,
        at_risk_tasks: [],
        critical_tasks: [],
        last_saved: null,
        recalculated_at: null,
      }),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/overview/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        schedule_health: 'unknown',
        spi: null,
        tasks_late_count: 0,
        critical_task_count: 2,
        total_tasks: 2,
        complete_tasks: 0,
        next_milestone: null,
        team_utilization_pct: null,
        owner_name: null,
        start_date: '2026-09-01',
      }),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/attention/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [] }),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/my-tasks/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ tasks: [] }),
    }),
  );
  await page.route('**/api/v1/tasks/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 2, next: null, previous: null, results: FIXTURE_TASKS }),
    }),
  );
  await page.route('**/api/v1/dependencies/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/monte-carlo/latest/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(FIXTURE_MC_RESULT),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/monte-carlo/history/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(FIXTURE_MC_HISTORY),
    }),
  );
  // Stub current-user for role gating
  await page.route('**/api/v1/auth/me/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'u1', email: 'pm@example.com', first_name: 'P', last_name: 'M' }),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/role/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ role: 300 }), // PM role
    }),
  );

  await page.goto(`/projects/${PROJECT_ID}/schedule`);
}

// Catch-all 401-guard, registered in a top-level beforeEach so it is the EARLIEST
// route — every specific route added later (per-test handlers and gotoScheduleWithMC)
// wins over it by Playwright's LIFO precedence. Any endpoint the app-wide shell +
// ⌘K palette read but these specs do not mock (programs, sprints, velocity, …)
// would otherwise cascade through 401-recovery into the SessionExpired banner,
// which then intercepts every click. #647's extra app-wide subscriptions removed
// the timing slack that previously let these specs pass without the guard. It must
// NOT live in gotoScheduleWithMC: that runs after the per-test /monte-carlo/ route
// here, and a late catch-all would shadow it (the recomputing-indicator test).
test.beforeEach(async ({ page }) => {
  await page.route('**/api/v1/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
});

test.describe('Monte Carlo Schedule Integration (#333)', () => {
  test('P50/P80/P95 markers are visible on the Gantt timeline', async ({ page }) => {
    await gotoScheduleWithMC(page);

    // Markers mount once the canvas engine is ready. They self-hide when
    // outside the viewport (style.visibility = 'hidden' when x < -120 or
    // x > viewportWidth + 4), so wait for DOM attach (not visibility), then
    // scroll the canvas so the P80 marker (the middle percentile, Dec 10) is
    // centered horizontally — this brings P50, P80, and P95 all into view.
    // Each marker's inline `style.left` is viewport-relative; adding the
    // current scrollLeft recovers its canvas-origin coordinate.
    await page.waitForSelector('[data-testid="mc-marker-p80"]', {
      state: 'attached',
      timeout: 10_000,
    });
    await page.evaluate(() => {
      const scroller = document.querySelector(
        '[data-testid="schedule-canvas-scroll"]',
      ) as HTMLElement | null;
      const marker = document.querySelector('[data-testid="mc-marker-p80"]') as HTMLElement | null;
      if (!scroller || !marker) return;
      const viewportLeft = parseFloat(marker.style.left || '0');
      const canvasOriginX = viewportLeft + scroller.scrollLeft;
      scroller.scrollLeft = Math.max(0, canvasOriginX - scroller.clientWidth / 2);
    });

    await expect(page.locator('[data-testid="mc-marker-p50"]')).toBeVisible();
    await expect(page.locator('[data-testid="mc-marker-p80"]')).toBeVisible();
    await expect(page.locator('[data-testid="mc-marker-p95"]')).toBeVisible();
  });

  test('P80 chip shows delta vs CPM finish on the consolidated bar', async ({ page }) => {
    await gotoScheduleWithMC(page);

    // The single consolidated bar (ADR-0144, rule 189) renders the P80 chip ONCE.
    // CPM finish = '2026-11-30', P80 = '2026-12-10' → "Dec 10 (+10d)". The date is
    // formatted in UTC (fmtUtcShort) so it does not drift west of UTC.
    const bar = page.getByRole('region', { name: 'Schedule forecast' });
    await expect(bar.getByText('P80: Dec 10 (+10d)')).toBeVisible({ timeout: 10_000 });
    // Rendered exactly once — the old MonteCarloRow + ScheduleInsightsBar
    // double-claim of the percentiles is gone.
    await expect(bar.getByText(/^P80:/)).toHaveCount(1);
  });

  test('recomputing indicator appears when Rerun is clicked', async ({ page }) => {
    let runCallCount = 0;
    await page.route(`**/api/v1/projects/${PROJECT_ID}/monte-carlo/`, async (route) => {
      runCallCount++;
      // Delay the response so we can observe the pending state
      await new Promise((r) => setTimeout(r, 200));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
    });

    await gotoScheduleWithMC(page);

    await page.waitForSelector('[aria-label="Rerun Monte Carlo forecast"]', { timeout: 10_000 });
    await page.click('[aria-label="Rerun Monte Carlo forecast"]');

    await expect(page.locator('[data-testid="mc-recomputing"]')).toBeVisible({ timeout: 5_000 });
    expect(runCallCount).toBe(1);
  });

  test('Details button opens the Monte Carlo detail panel', async ({ page }) => {
    await gotoScheduleWithMC(page);

    await page.waitForSelector('[data-testid="mc-details-btn"]', { timeout: 10_000 });
    await page.click('[data-testid="mc-details-btn"]');

    await expect(page.locator('[data-testid="mc-detail-panel"]')).toBeVisible({ timeout: 5_000 });
    await expect(
      page
        .locator('[data-testid="mc-detail-panel"]')
        .getByRole('img', { name: /Monte Carlo distribution/i }),
    ).toBeVisible();
  });

  test('detail panel closes on Escape', async ({ page }) => {
    await gotoScheduleWithMC(page);

    await page.waitForSelector('[data-testid="mc-details-btn"]', { timeout: 10_000 });
    await page.click('[data-testid="mc-details-btn"]');
    await expect(page.locator('[data-testid="mc-detail-panel"]')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="mc-detail-panel"]')).not.toBeVisible({
      timeout: 3_000,
    });
  });

  test('consolidated bar expands to show the histogram and the tornado (#1222, ADR-0144)', async ({
    page,
  }) => {
    await gotoScheduleWithMC(page);

    // Scope to the consolidated bar region — "What's holding the date" also
    // appears in the (DOM-present but hidden) detail drawer, so an unscoped text
    // query would be a strict-mode collision.
    const bar = page.getByRole('region', { name: 'Schedule forecast' });
    const toggle = bar.getByRole('button', { name: /Maximize forecast detail/i });
    await expect(toggle).toBeVisible({ timeout: 10_000 });
    // Collapsed by default — the two-column body is not shown.
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(bar.getByText('Finish-date forecast')).toHaveCount(0);

    await toggle.click();

    await expect(
      bar.getByRole('button', { name: /Minimize forecast detail/i }),
    ).toHaveAttribute('aria-expanded', 'true');
    await expect(bar.getByText('Finish-date forecast')).toBeVisible();
    await expect(bar.getByText(/What.s holding the date/i)).toBeVisible();
    // The sensitivity bar is joined to the driving task's name.
    await expect(
      bar.getByRole('img', { name: /Backend API: 88% sensitivity/i }),
    ).toBeVisible();
  });

  test('the percentiles render on exactly one surface (rule 189)', async ({ page }) => {
    await gotoScheduleWithMC(page);
    // The whole point of ADR-0144: no second copy of the percentile chips. The
    // consolidated bar owns them; the old top MonteCarloRow strip is deleted.
    const bar = page.getByRole('region', { name: 'Schedule forecast' });
    await expect(bar.getByText(/^P50:/)).toHaveCount(1);
    await expect(bar.getByText(/^P80:/)).toHaveCount(1);
    await expect(bar.getByText(/^P95:/)).toHaveCount(1);
  });
});

test.describe('Monte Carlo forecast history (#961, ADR-0109)', () => {
  async function openMcPanel(page: import('@playwright/test').Page) {
    await gotoScheduleWithMC(page);
    // Open the MC confidence drawer from the shell health-cluster forecast band.
    await page.click('[aria-label^="Monte Carlo forecast"]', { timeout: 10_000 });
    await expect(
      page.getByRole('dialog', { name: /Monte Carlo confidence distribution/i }),
    ).toBeVisible();
  }

  test('golden path: history section shows runs with a P80 drift delta', async ({ page }) => {
    await openMcPanel(page);

    const section = page.getByRole('region', { name: /Forecast history/i });
    await expect(section).toBeVisible();
    // Newest run slipped +14d on P80 vs the previous run.
    await expect(section.getByText('▲ +14d')).toBeVisible();
    // Oldest run is the baseline (no delta).
    await expect(section.getByText('— baseline')).toBeVisible();
  });

  test('empty state: no history section when no runs are recorded', async ({ page }) => {
    await gotoScheduleWithMC(page);
    // Override the history route AFTER setup so this empty response wins (Playwright
    // matches most-recently-registered first); the panel fetches on pill click.
    await page.route(`**/api/v1/projects/${PROJECT_ID}/monte-carlo/history/`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ results: [], cap: 100 }),
      }),
    );
    await page.click('[aria-label^="Monte Carlo forecast"]', { timeout: 10_000 });
    await expect(
      page.getByRole('dialog', { name: /Monte Carlo confidence distribution/i }),
    ).toBeVisible();
    // The drawer opens, but the history region must not render with no runs.
    await expect(page.getByRole('region', { name: /Forecast history/i })).toHaveCount(0);
  });
});
