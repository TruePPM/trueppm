/**
 * Wave 10 — Sprints view metrics row E2E (issue #228).
 *
 * Verifies that the burndown chart, capacity preflight, and velocity panel
 * render below the existing sprint header when an ACTIVE sprint exists, and
 * pull data from the right endpoints.
 */
import { test, expect } from '@playwright/test';

const PROJECT_ID = 'e2e-sprints-metrics-00000000-0000-0000-0000-000000000020';
const BASE_URL = `/projects/${PROJECT_ID}/sprints`;

const FIXTURE_PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Sprints Metrics Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
    methodology: 'AGILE',
  },
];

const PROJECT_DETAIL = {
  id: PROJECT_ID,
  server_version: 1,
  name: 'Sprints Metrics Project',
  description: '',
  start_date: '2026-04-01',
  calendar: null,
  estimation_mode: 'open',
  agile_features: true,
  methodology: 'AGILE',
};

const ACTIVE_SPRINT = {
  id: 'sp-active',
  server_version: 1,
  short_id: 'C0FF',
  short_id_display: 'SP-C0FF',
  name: 'Telemetry & FAT prep',
  goal: 'Close out telemetry firmware sweep.',
  start_date: '2026-04-01',
  finish_date: '2026-04-14',
  state: 'ACTIVE',
  target_milestone: null,
  target_milestone_detail: null,
  committed_points: 40,
  committed_task_count: 18,
  completed_points: 14,
  completed_task_count: 6,
  completion_ratio_points: 0.35,
  completion_ratio_tasks: 0.33,
  activated_at: '2026-04-01T00:00:00Z',
  closed_at: null,
  created_at: '2026-04-01T00:00:00Z',
  updated_at: '2026-04-04T12:00:00Z',
};

const BURNDOWN_PAYLOAD = {
  sprint: ACTIVE_SPRINT,
  snapshots: [
    { id: 'sn1', snapshot_date: '2026-04-01', remaining_points: 40, remaining_task_count: 18, completed_points: 0, completed_task_count: 0, scope_change_points: 0, scope_change_task_count: 0, created_at: '2026-04-01T00:00:00Z' },
    { id: 'sn2', snapshot_date: '2026-04-02', remaining_points: 36, remaining_task_count: 17, completed_points: 4, completed_task_count: 1, scope_change_points: 0, scope_change_task_count: 0, created_at: '2026-04-02T00:00:00Z' },
    { id: 'sn3', snapshot_date: '2026-04-03', remaining_points: 30, remaining_task_count: 15, completed_points: 10, completed_task_count: 3, scope_change_points: 0, scope_change_task_count: 0, created_at: '2026-04-03T00:00:00Z' },
    { id: 'sn4', snapshot_date: '2026-04-05', remaining_points: 33, remaining_task_count: 16, completed_points: 11, completed_task_count: 3, scope_change_points: 4, scope_change_task_count: 1, created_at: '2026-04-05T00:00:00Z' },
  ],
};

const CAPACITY_PAYLOAD = {
  members: [
    { member_id: 'r1', member_name: 'Aisha Khan', initials: 'AK', committed_hours: 60, available_hours: 80, ratio: 0.75, is_over: false },
    { member_id: 'r2', member_name: 'Ben Lee', initials: 'BL', committed_hours: 100, available_hours: 80, ratio: 1.25, is_over: true },
  ],
  totals: {
    committed_hours: 160,
    available_hours: 160,
    ratio: 1.0,
    buffer_hours: 0,
    label: 'at_risk',
    pto_days: 0,
  },
  working_days: 10,
  hours_per_day: 8,
};

const VELOCITY_PAYLOAD = {
  sprints: [
    { id: 's1', name: 'Sprint 1', start_date: '2026-01-01', finish_date: '2026-01-14', committed_points: 30, completed_points: 28, committed_task_count: 12, completed_task_count: 11 },
    { id: 's2', name: 'Sprint 2', start_date: '2026-01-15', finish_date: '2026-01-28', committed_points: 35, completed_points: 32, committed_task_count: 14, completed_task_count: 13 },
  ],
  rolling_avg_points: 30,
  rolling_stdev_points: 2.83,
  forecast_range_low: 27,
  forecast_range_high: 33,
  rolling_avg_tasks: 12,
  rolling_stdev_tasks: 1.41,
};

async function setupCommon(page: import('@playwright/test').Page) {
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
  await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(PROJECT_DETAIL),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/sprints/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 1, next: null, previous: null, results: [ACTIVE_SPRINT] }),
    }),
  );
  await page.route(`**/api/v1/sprints/${ACTIVE_SPRINT.id}/burndown/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(BURNDOWN_PAYLOAD) }),
  );
  await page.route(`**/api/v1/sprints/${ACTIVE_SPRINT.id}/capacity/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CAPACITY_PAYLOAD) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/velocity/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(VELOCITY_PAYLOAD) }),
  );
  // Sprint backlog (#229) is rendered by SprintsView and queries /tasks/ —
  // an unmocked call falls through to the real backend and triggers an auth
  // redirect. Stub it with an empty list since this spec is metrics-only.
  await page.route(/\/api\/v1\/tasks\//, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
  await page.route(/\/api\/v1\/sprints\/.*\/retro\//, (route) =>
    route.fulfill({ status: 404, contentType: 'application/json', body: '{"detail":"None"}' }),
  );
  await page.route('**/api/v1/me/active-sprints/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );

  await page.route('**/api/v1/projects/*/presence/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  await page.route('**/api/v1/projects/*/status-summary/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        task_count: 0, critical_path_count: 0, monte_carlo_p80: null,
        at_risk_count: 0, critical_count: 0, at_risk_tasks: [], critical_tasks: [],
        last_saved: null, recalculated_at: null,
      }),
    }),
  );
  await page.route('**/api/v1/edition/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ edition: 'community' }) }),
  );
  await page.route('**/api/v1/auth/me/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'e2e-user', username: 'e2e', display_name: 'E2E', initials: 'E', email: 'e2e@example.com' }),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'mem-1', role: 300 }]) }),
  );
}

test.describe('Wave 10 — Sprints metrics row', () => {
  test('renders burndown, capacity, and velocity panels for the active sprint', async ({ page }) => {
    await setupCommon(page);

    await page.goto(BASE_URL);

    await expect(page.getByRole('region', { name: /Sprint Burndown/i })).toBeVisible();
    // Scope change on 2026-04-05 (+4 points) is rendered as a Recharts ReferenceDot with
    // an aria-label, plus the legend chip "Scope added". The ideal-line "TODAY" marker
    // only appears when today falls within the sprint window, so we don't assert it here.
    await expect(page.getByLabel(/Scope change 2026-04-05: \+4/)).toBeVisible();
    await expect(page.getByText('Scope added')).toBeVisible();

    const capacity = page.getByRole('region', { name: /Capacity Preflight/i });
    await expect(capacity).toBeVisible();
    await expect(capacity.getByText('AK', { exact: true })).toBeVisible();
    await expect(capacity.getByText('BL', { exact: true })).toBeVisible();
    await expect(capacity.getByText('Aisha Khan')).toBeVisible();

    await expect(page.getByRole('region', { name: /Velocity/i })).toBeVisible();
    await expect(page.getByLabel(/Forecast range 27 to 33 points/)).toBeVisible();
    await expect(page.getByRole('link', { name: 'ADR-0036' })).toBeVisible();
  });
});
