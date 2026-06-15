/**
 * Configurable iteration terminology (#862, ADR-0111) — propagation E2E.
 *
 * Proves that a project's `iteration_label` flows through the iteration surfaces:
 * with the label set to "Iteration", the Sprints tab, breadcrumb, header heading,
 * cadence region, and the plan/close controls all read "Iteration"/"Iterations"
 * rather than the hard-coded "Sprint".
 *
 * The default-"Sprint" behavior is covered by the existing wave10-sprints-* specs
 * (which mock a project with no iteration_label → the resolver falls back to "Sprint"),
 * so this spec only exercises the non-default path.
 */
import { test, expect } from '@playwright/test';

const PROJECT_ID = 'e2e-itl-00000000-0000-0000-0000-000000000862';
const BASE_URL = `/projects/${PROJECT_ID}/sprints`;

const FIXTURE_PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Terminology Test Project',
    description: '',
    start_date: '2026-01-01',
    calendar: 'default',
    methodology: 'AGILE',
  },
];

const PROJECT_DETAIL = {
  id: PROJECT_ID,
  server_version: 1,
  name: 'Terminology Test Project',
  description: '',
  start_date: '2026-01-01',
  calendar: null,
  estimation_mode: 'open',
  agile_features: true,
  methodology: 'AGILE',
  // The feature under test: this project calls its container an "Iteration".
  iteration_label: 'Iteration',
};

const ACTIVE_SPRINT = {
  id: 'sp-active',
  server_version: 1,
  short_id: 'C0FF',
  short_id_display: 'SP-C0FF',
  name: 'Telemetry & FAT prep',
  goal: 'Close out telemetry firmware channel sweep.',
  start_date: '2026-04-01',
  finish_date: '2026-04-14',
  state: 'ACTIVE',
  target_milestone: null,
  target_milestone_detail: null,
  committed_points: 47,
  committed_task_count: 18,
  completed_points: 24,
  completed_task_count: 9,
  completion_ratio_points: 0.51,
  completion_ratio_tasks: 0.5,
  activated_at: '2026-04-01T00:00:00Z',
  closed_at: null,
  created_at: '2026-04-01T00:00:00Z',
  updated_at: '2026-04-04T12:00:00Z',
};

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

  const json = (body: unknown) => ({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });

  await page.route('**/api/v1/projects/', (route) =>
    route.fulfill(json({ count: 1, next: null, previous: null, results: FIXTURE_PROJECTS })),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (route) => route.fulfill(json(PROJECT_DETAIL)));
  await page.route('**/api/v1/projects/*/presence/', (route) => route.fulfill(json([])));
  await page.route('**/api/v1/projects/*/status-summary/', (route) =>
    route.fulfill(
      json({
        task_count: 0, critical_path_count: 0, monte_carlo_p80: null,
        at_risk_count: 0, critical_count: 0, at_risk_tasks: [], critical_tasks: [],
        last_saved: null, recalculated_at: null,
      }),
    ),
  );
  await page.route('**/api/v1/edition/', (route) => route.fulfill(json({ edition: 'community' })));
  await page.route('**/api/v1/auth/me/', (route) =>
    route.fulfill(
      json({ id: 'e2e-user', username: 'e2e', display_name: 'E2E', initials: 'E', email: 'e2e@example.com' }),
    ),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/**`, (route) =>
    route.fulfill(json([{ id: 'mem-1', role: 300 }])),
  );
  await page.route(/\/api\/v1\/sprints\/.*\/burndown\//, (route) =>
    route.fulfill(json({ sprint: ACTIVE_SPRINT, snapshots: [] })),
  );
  await page.route(/\/api\/v1\/sprints\/.*\/capacity\//, (route) =>
    route.fulfill(
      json({
        members: [],
        totals: { committed_hours: 0, available_hours: 0, ratio: 0, buffer_hours: 0, label: 'on_track', pto_days: 0 },
        working_days: 0, hours_per_day: 8,
      }),
    ),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/velocity/`, (route) =>
    route.fulfill(
      json({
        sprints: [], rolling_avg_points: null, rolling_stdev_points: null,
        forecast_range_low: null, forecast_range_high: null,
        rolling_avg_tasks: null, rolling_stdev_tasks: null,
      }),
    ),
  );
  await page.route(/\/api\/v1\/tasks\//, (route) =>
    route.fulfill(json({ count: 0, next: null, previous: null, results: [] })),
  );
  await page.route(/\/api\/v1\/sprints\/.*\/retro\//, (route) =>
    route.fulfill({ status: 404, contentType: 'application/json', body: '{"detail":"None"}' }),
  );
  await page.route('**/api/v1/me/active-sprints/', (route) => route.fulfill(json([])));
  await page.route(`**/api/v1/projects/${PROJECT_ID}/sprints/`, (route) =>
    route.fulfill(json({ count: 1, next: null, previous: null, results: [ACTIVE_SPRINT] })),
  );
}

test.describe('Configurable iteration terminology', () => {
  test('the configured label propagates to the sprint surfaces', async ({ page }) => {
    await setup(page);
    await page.goto(BASE_URL);

    // Breadcrumb + tab use the plural form. Scope to the in-view breadcrumb —
    // the global context bar (ADR-0127) also renders a "Breadcrumb" nav outside
    // #main-content.
    await expect(
      page.locator('#main-content').getByRole('navigation', { name: /Breadcrumb/i }),
    ).toContainText('Iterations');

    // Header heading uses the singular form (not "Sprint N — …").
    await expect(
      page.getByRole('heading', { level: 1, name: /Iteration 1 — Telemetry & FAT prep/ }),
    ).toBeVisible();

    // Cadence region is renamed.
    await expect(page.getByRole('region', { name: /Iteration Cadence/i })).toBeVisible();

    // The close control reads "Close active iteration".
    await expect(page.getByRole('button', { name: /Close active iteration/i })).toBeVisible();

    // And no "Sprint" container wording leaks into the in-view breadcrumb.
    await expect(
      page.locator('#main-content').getByRole('navigation', { name: /Breadcrumb/i }),
    ).not.toContainText('Sprints');
  });
});
