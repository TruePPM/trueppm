/**
 * Sprint "Exclude from velocity" — Sprint 0 escape hatch E2E (#1092, ADR-0113).
 *
 * Verifies the SCHEDULER+ toggle renders on the sprint workspace, the velocity
 * panel marks (does not drop) an excluded sprint and surfaces the "N excluded"
 * callout, and toggling PATCHes `exclude_from_velocity` to the sprint endpoint.
 */
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-excl-velocity-0000-0000-0000-000000001092';
const BASE_URL = `/projects/${PROJECT_ID}/sprints`;

const PROJECT_DETAIL = {
  id: PROJECT_ID,
  server_version: 1,
  name: 'Exclude Velocity Project',
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
  name: 'Telemetry sweep',
  goal: 'Close out telemetry firmware sweep.',
  start_date: '2026-04-01',
  finish_date: '2026-04-14',
  state: 'ACTIVE',
  target_milestone: null,
  target_milestone_detail: null,
  capacity_points: 40,
  wip_limit: null,
  exclude_from_velocity: false,
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

const VELOCITY_PAYLOAD = {
  sprints: [
    { id: 's0', name: 'Sprint 0', start_date: '2026-01-01', finish_date: '2026-01-14', committed_points: 10, completed_points: 3, committed_task_count: 4, completed_task_count: 1, exclude_from_velocity: true },
    { id: 's1', name: 'Sprint 1', start_date: '2026-01-15', finish_date: '2026-01-28', committed_points: 30, completed_points: 28, committed_task_count: 12, completed_task_count: 11, exclude_from_velocity: false },
    { id: 's2', name: 'Sprint 2', start_date: '2026-01-29', finish_date: '2026-02-11', committed_points: 30, completed_points: 32, committed_task_count: 12, completed_task_count: 13, exclude_from_velocity: false },
  ],
  rolling_avg_points: 30,
  rolling_stdev_points: 2.83,
  forecast_range_low: 27,
  forecast_range_high: 33,
  rolling_avg_tasks: 12,
  rolling_stdev_tasks: 1.41,
  team_velocity_per_day: 3,
  excluded_count: 1,
};

async function setupCommon(page: import('@playwright/test').Page) {
  // Seed the in-memory token so the app boots past the #911 bootstrap refresh
  // (route-mocked specs have no refresh backend → session-expired otherwise).
  await setupAuth(page);
  // Register the catch-all FIRST so any endpoint not mocked below returns 404
  // instead of falling through to the real backend → 401 → session-expired.
  // The specific routes below win (Playwright: last-registered wins).
  await setupCatchAll(page);

  await page.route('**/api/v1/projects/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 1, next: null, previous: null, results: [PROJECT_DETAIL] }) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PROJECT_DETAIL) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/sprints/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 1, next: null, previous: null, results: [ACTIVE_SPRINT] }) }),
  );
  await page.route(`**/api/v1/sprints/${ACTIVE_SPRINT.id}/burndown/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sprint: ACTIVE_SPRINT, snapshots: [] }) }),
  );
  await page.route(`**/api/v1/sprints/${ACTIVE_SPRINT.id}/capacity/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ members: [], totals: { committed_hours: 0, available_hours: 0, ratio: 0, buffer_hours: 0, label: 'on_track', pto_days: 0 }, working_days: 10, hours_per_day: 8 }) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/velocity/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(VELOCITY_PAYLOAD) }),
  );
  await page.route(/\/api\/v1\/tasks\//, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }) }),
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
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ task_count: 0, critical_path_count: 0, monte_carlo_p80: null, at_risk_count: 0, critical_count: 0, at_risk_tasks: [], critical_tasks: [], last_saved: null, recalculated_at: null }) }),
  );
  await page.route('**/api/v1/edition/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ edition: 'community' }) }),
  );
  await page.route('**/api/v1/auth/me/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'e2e-user', username: 'e2e', display_name: 'E2E', initials: 'E', email: 'e2e@example.com' }) }),
  );
  // Scheduler-equivalent role (300 = ADMIN ≥ SCHEDULER 200) so the toggle is
  // editable. useCurrentUserRole calls /members/?self=true — a regex is required
  // so the query string still matches (a trailing-slash glob would miss it).
  await page.route(/\/api\/v1\/projects\/[^/]+\/members\//, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'mem-1', role: 300 }]) }),
  );
}

test.describe('Sprint exclude_from_velocity (#1092)', () => {
  test('shows the toggle and the excluded-from-forecast callout', async ({ page }) => {
    await setupCommon(page);
    await page.goto(BASE_URL);

    // The team-owned toggle renders on the sprint workspace.
    await expect(page.getByRole('switch', { name: /Exclude Telemetry sweep from velocity/i })).toBeVisible();

    // The velocity panel surfaces the plain-language "N excluded" callout.
    const velocity = page.getByRole('region', { name: /Velocity/i });
    await expect(velocity).toBeVisible();
    await expect(velocity.getByText(/1 excluded/)).toBeVisible();
  });

  test('toggling PATCHes exclude_from_velocity to the sprint', async ({ page }) => {
    await setupCommon(page);

    let patchBody: Record<string, unknown> | null = null;
    await page.route(`**/api/v1/sprints/${ACTIVE_SPRINT.id}/`, async (route) => {
      if (route.request().method() === 'PATCH') {
        patchBody = route.request().postDataJSON() as Record<string, unknown>;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ...ACTIVE_SPRINT, exclude_from_velocity: true, server_version: 2 }),
        });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ACTIVE_SPRINT) });
    });

    await page.goto(BASE_URL);
    const toggle = page.getByRole('switch', { name: /Exclude Telemetry sweep from velocity/i });
    await expect(toggle).toBeVisible();
    await toggle.click();

    await expect.poll(() => patchBody).toEqual({ exclude_from_velocity: true });
  });
});
