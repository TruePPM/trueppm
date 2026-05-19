import { test, expect } from '@playwright/test';

/**
 * Monte Carlo strip integration tests for the Schedule view — issue #333.
 *
 * Covers:
 * - P50/P80/P95 markers visible on Gantt timeline
 * - Footer strip shows P80 delta vs CPM finish
 * - Recomputing indicator appears when Rerun is clicked
 * - Details panel opens on Details button click
 */

const PROJECT_ID = 'e2e-mc-00000000-0000-0000-0000-000000000099';

const FIXTURE_PROJECTS = [
  { id: PROJECT_ID, name: 'MC Test Project', description: '', start_date: '2026-09-01', calendar: 'default' },
];

const FIXTURE_TASKS = [
  {
    id: 'mc-t1', wbs_path: '1', name: 'Phase 1',
    early_start: '2026-09-01', early_finish: '2026-11-30',
    planned_start: '2026-09-01',
    duration: 60, percent_complete: 0, is_critical: true, is_milestone: false, is_summary: true,
    optimistic_duration: null, pessimistic_duration: null, most_likely_duration: null, notes: '',
    server_version: 1,
  },
  {
    id: 'mc-t2', wbs_path: '1.1', name: 'Backend API',
    early_start: '2026-09-01', early_finish: '2026-10-20',
    planned_start: '2026-09-01',
    duration: 50, percent_complete: 0, is_critical: true, is_milestone: false, is_summary: false,
    optimistic_duration: 40, pessimistic_duration: 65, most_likely_duration: 50, notes: '',
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
        task_count: 2, critical_path_count: 2, monte_carlo_p80: '2026-12-10',
        at_risk_count: 0, critical_count: 0, at_risk_tasks: [], critical_tasks: [],
        last_saved: null, recalculated_at: null,
      }),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/overview/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ schedule_health: 'unknown', spi: null, tasks_late_count: 0, critical_task_count: 2, total_tasks: 2, complete_tasks: 0, next_milestone: null, team_utilization_pct: null, owner_name: null, start_date: '2026-09-01' }),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/attention/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/my-tasks/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tasks: [] }) }),
  );
  await page.route('**/api/v1/tasks/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 2, next: null, previous: null, results: FIXTURE_TASKS }),
    }),
  );
  await page.route('**/api/v1/dependencies/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/monte-carlo/latest/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(FIXTURE_MC_RESULT),
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
      const marker = document.querySelector(
        '[data-testid="mc-marker-p80"]',
      ) as HTMLElement | null;
      if (!scroller || !marker) return;
      const viewportLeft = parseFloat(marker.style.left || '0');
      const canvasOriginX = viewportLeft + scroller.scrollLeft;
      scroller.scrollLeft = Math.max(0, canvasOriginX - scroller.clientWidth / 2);
    });

    await expect(page.locator('[data-testid="mc-marker-p50"]')).toBeVisible();
    await expect(page.locator('[data-testid="mc-marker-p80"]')).toBeVisible();
    await expect(page.locator('[data-testid="mc-marker-p95"]')).toBeVisible();
  });

  test('P80 chip shows delta vs CPM finish in footer', async ({ page }) => {
    await gotoScheduleWithMC(page);

    // CPM finish = '2026-11-30', P80 = '2026-12-10' → +10d
    await expect(
      page.locator('[aria-label*="Monte Carlo confidence row"]').filter({ hasText: '+10d' }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('recomputing indicator appears when Rerun is clicked', async ({ page }) => {
    let runCallCount = 0;
    await page.route(`**/api/v1/projects/${PROJECT_ID}/monte-carlo/`, async (route) => {
      runCallCount++;
      // Delay the response so we can observe the pending state
      await new Promise((r) => setTimeout(r, 200));
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
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
      page.locator('[data-testid="mc-detail-panel"]').getByRole('img', { name: /Monte Carlo distribution/i }),
    ).toBeVisible();
  });

  test('detail panel closes on Escape', async ({ page }) => {
    await gotoScheduleWithMC(page);

    await page.waitForSelector('[data-testid="mc-details-btn"]', { timeout: 10_000 });
    await page.click('[data-testid="mc-details-btn"]');
    await expect(page.locator('[data-testid="mc-detail-panel"]')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="mc-detail-panel"]')).not.toBeVisible({ timeout: 3_000 });
  });
});
