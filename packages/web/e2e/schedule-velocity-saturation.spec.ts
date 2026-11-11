import { test, expect } from './fixtures/coverage';
import { setupApiMocks, setupAuth, setupCatchAll, type ProjectFixture } from './fixtures';

/**
 * The Schedule finish-date forecast card's velocity-saturation note (#4954).
 *
 * `velocity_saturated_runs` > 0 means runs hit the sprint horizon, so P80/P95 are lower
 * bounds and the note says how many. 0 or an absent field (the persisted-history
 * fallback) must claim nothing. Every endpoint the page reads is mocked with its real
 * shape; the object-shaped ones must not fall through to the list-shaped catch-all.
 */

const PROJECT_ID = 'e2e-sat-00000000-0000-0000-0000-000000004954';

const PROJECT: ProjectFixture = {
  id: PROJECT_ID,
  name: 'Saturation Fixture',
  description: 'Velocity saturation note fixture.',
  start_date: '2026-01-01',
  calendar: 'default',
};

const TASKS = Array.from({ length: 4 }, (_, i) => ({
  id: `sat-t${i + 1}`,
  wbs_path: `${i + 1}`,
  name: `Task ${i + 1}`,
  early_start: '2026-01-05',
  early_finish: '2026-01-09',
  planned_start: '2026-01-05',
  duration: 5,
  percent_complete: 0,
  is_critical: false,
  is_milestone: false,
  is_summary: false,
  status: 'NOT_STARTED',
  optimistic_duration: null,
  pessimistic_duration: null,
  most_likely_duration: null,
  notes: '',
  server_version: 1,
}));

const MC_RESULT = {
  project_id: PROJECT_ID,
  runs: 500,
  p50: '2026-11-15',
  p80: '2026-12-10',
  p95: '2026-12-28',
  histogram_buckets: [
    { date: '2026-11-02', count: 90 },
    { date: '2026-11-09', count: 120 },
    { date: '2026-11-16', count: 100 },
    { date: '2026-11-23', count: 70 },
    { date: '2026-11-30', count: 45 },
  ],
  // The server states forecast freshness on every branch (#3140). Stated here so the
  // one spec that guards this bar's 1280px layout measures the row production actually
  // renders — an omitted key maps to `unknown`, which adds a Rerun button the server
  // would never have asked for.
  forecast_staleness: 'current',
  plan_version: 1,
  plan_version_current: 1,
  last_run_at: '2026-05-12T10:00:00Z',
  cpm_finish: '2026-11-30',
  delta_vs_cpm: { p50: -15, p80: 10, p95: 28 },
  risk_premium_state: 'premium',
  risk_premium_days: 10,
  risk_premium_ratio: 0.05,
  risk_premium_band: null,
  risk_premium_as_of: '2026-05-12T10:00:00Z',
  risk_premium_reason: null,
  risk_premium_cpm_finish: '2026-11-30',
  risk_premium_p80: '2026-12-10',
  confidence_curve: [
    { date: '2026-11-02', pct: 28 },
    { date: '2026-11-09', pct: 52 },
    { date: '2026-11-16', pct: 72 },
    { date: '2026-11-23', pct: 86 },
    { date: '2026-11-30', pct: 95 },
  ],
  sensitivity: [{ task_id: 'sat-t1', index: 0.88 }],
};


async function setup(page: import('@playwright/test').Page, extra: Record<string, unknown>) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, { projects: [PROJECT], projectId: PROJECT_ID, tasks: TASKS });
  await page.route('**/api/v1/programs/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
  await page.route('**/api/v1/me/work/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        results: [],
        next: null,
        previous: null,
        active_sprints: [],
        due_today_count: 0,
        server_version_high_water: 0,
      }),
    }),
  );
  await page.route('**/api/v1/me/timer/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ active: false }) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/monte-carlo/latest/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...MC_RESULT, ...extra }),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/monte-carlo/history/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ results: [], cap: 100, enabled: true }),
    }),
  );
  await page.addInitScript(() => {
    localStorage.setItem('schedule.insightsExpanded', 'true');
  });
}

test.describe('Schedule forecast: velocity saturation note (#4954)', () => {
  test('shows the saturated-run count and share when runs hit the horizon', async ({ page }) => {
    await setup(page, { velocity_saturated_runs: 250 });
    await page.goto(`/projects/${PROJECT_ID}/schedule`);
    const note = page.getByTestId('velocity-saturation-note');
    await expect(note).toBeVisible();
    await expect(note).toContainText('P80 and P95 are lower bounds');
    await expect(note).toContainText('250');
    await expect(note).toContainText('500');
    await expect(note).toContainText('50%');
  });

  for (const [label, extra] of [
    ['zero saturated runs', { velocity_saturated_runs: 0 }],
    ['the field absent', {}],
  ] as const) {
    test(`shows nothing with ${label}`, async ({ page }) => {
      await setup(page, extra);
      await page.goto(`/projects/${PROJECT_ID}/schedule`);
      // Gate on the card having rendered its expanded body before asserting absence.
      await expect(page.getByText(/Monte Carlo · 500 runs/)).toBeVisible();
      await expect(page.getByTestId('velocity-saturation-note')).toHaveCount(0);
    });
  }
});
