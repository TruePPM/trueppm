/**
 * Wave 10 — Multi-team Sprints lens E2E (issue #230).
 *
 * Verifies that the My Teams toggle appears when the user has 2+ active
 * sprint assignments and that switching to it renders the team summary
 * cards instead of the single-project view.
 */
import { test, expect } from '@playwright/test';

const PROJECT_ID = 'e2e-sprints-lens-00000000-0000-0000-0000-000000000040';
const BASE_URL = `/projects/${PROJECT_ID}/sprints`;

const FIXTURE_PROJECTS = [
  { id: PROJECT_ID, name: 'Lens Project', description: '', start_date: '2026-04-01', calendar: 'default', methodology: 'AGILE' },
];

const PROJECT_DETAIL = {
  id: PROJECT_ID,
  server_version: 1,
  name: 'Lens Project',
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
  short_id: 'L1',
  short_id_display: 'SP-L1',
  name: 'Lens sprint',
  goal: '',
  start_date: '2026-04-01',
  finish_date: '2026-04-14',
  state: 'ACTIVE',
  target_milestone: null,
  target_milestone_detail: null,
  committed_points: 40, committed_task_count: 0,
  completed_points: 0, completed_task_count: 0,
  completion_ratio_points: 0, completion_ratio_tasks: 0,
  activated_at: '2026-04-01T00:00:00Z',
  closed_at: null,
  created_at: '2026-04-01T00:00:00Z',
  updated_at: '2026-04-01T00:00:00Z',
};

const ME_ACTIVE_TWO = [
  {
    project_id: PROJECT_ID,
    project_name: 'Lens Project',
    sprint: { id: 'sp-active', name: 'Lens sprint', short_id_display: 'SP-L1', start_date: '2026-04-01', finish_date: '2026-04-14', day: 7, total: 14, remaining_points: 30, committed_points: 40, trend_pts: -10 },
    capacity_ratio: 0.95,
    capacity_label: 'at_risk' as const,
    velocity: { rolling_avg_points: 38, forecast_range_low: 32, forecast_range_high: 45 },
  },
  {
    project_id: 'other-project',
    project_name: 'Other Team Project',
    sprint: { id: 'sp-other', name: 'Other sprint', short_id_display: 'SP-O1', start_date: '2026-04-01', finish_date: '2026-04-14', day: 7, total: 14, remaining_points: 12, committed_points: 30, trend_pts: 4 },
    capacity_ratio: 0.6,
    capacity_label: 'on_track' as const,
    velocity: { rolling_avg_points: 28, forecast_range_low: 24, forecast_range_high: 32 },
  },
];

async function setupCommon(page: import('@playwright/test').Page, meActive: unknown[]) {
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
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 1, next: null, previous: null, results: FIXTURE_PROJECTS }) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PROJECT_DETAIL) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/sprints/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 1, next: null, previous: null, results: [ACTIVE_SPRINT] }) }),
  );
  await page.route(/\/api\/v1\/sprints\/.*\/burndown\//, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sprint: ACTIVE_SPRINT, snapshots: [] }) }),
  );
  await page.route(/\/api\/v1\/sprints\/.*\/capacity\//, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      members: [],
      totals: { committed_hours: 0, available_hours: 0, ratio: 0, buffer_hours: 0, label: 'on_track', pto_days: 0 },
      working_days: 0, hours_per_day: 8,
    }) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/velocity/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      sprints: [], rolling_avg_points: null, rolling_stdev_points: null,
      forecast_range_low: null, forecast_range_high: null,
      rolling_avg_tasks: null, rolling_stdev_tasks: null,
    }) }),
  );
  await page.route(/\/api\/v1\/tasks\//, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }) }),
  );
  await page.route(/\/api\/v1\/sprints\/.*\/retro\//, (route) =>
    route.fulfill({ status: 404, contentType: 'application/json', body: '{"detail":"None"}' }),
  );
  await page.route('**/api/v1/me/active-sprints/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(meActive) }),
  );

  await page.route('**/api/v1/projects/*/presence/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  await page.route('**/api/v1/projects/*/status-summary/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      task_count: 0, critical_path_count: 0, monte_carlo_p80: null,
      at_risk_count: 0, critical_count: 0, at_risk_tasks: [], critical_tasks: [],
      last_saved: null, recalculated_at: null,
    }) }),
  );
  await page.route('**/api/v1/edition/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ edition: 'community' }) }),
  );
  await page.route('**/api/v1/auth/me/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'e2e-user', username: 'e2e', display_name: 'E2E', initials: 'E', email: 'e2e@example.com' }) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'mem-1', role: 300 }]) }),
  );
}

test.describe('Wave 10 — Multi-team Sprints lens', () => {
  test('toggle is hidden when user has only one active sprint', async ({ page }) => {
    await setupCommon(page, [ME_ACTIVE_TWO[0]]);
    await page.goto(BASE_URL);
    await expect(page.getByRole('tablist', { name: /Sprint scope/i })).toHaveCount(0);
  });

  test('toggle appears with 2+ active sprints and switches to the lens', async ({ page }) => {
    await setupCommon(page, ME_ACTIVE_TWO);
    await page.goto(BASE_URL);

    const toggle = page.getByRole('tablist', { name: /Sprint scope/i });
    await expect(toggle).toBeVisible();

    // Switch scope.
    await page.getByRole('tab', { name: /My Teams \(2\)/i }).click();

    const lens = page.getByRole('region', { name: /My Teams/i });
    await expect(lens).toBeVisible();
    await expect(lens.getByText('Lens Project')).toBeVisible();
    await expect(lens.getByText('Other Team Project')).toBeVisible();
    await expect(lens.getByText(/10 pts behind/i)).toBeVisible();
    await expect(lens.getByText(/4 pts ahead/i)).toBeVisible();

    // Card link to other project.
    const otherLink = lens.getByRole('link', { name: /Other Team Project/i });
    await expect(otherLink).toHaveAttribute('href', '/projects/other-project/sprints');
  });
});
