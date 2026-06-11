/**
 * Daily standup delta E2E (#925, ADR-0121). The active sprint shows a team
 * "what changed since yesterday" panel populated from /sprints/{id}/daily-delta/:
 * moved cards, new blockers, scope, burndown swing, and a per-actor at-a-glance.
 */
import { test, expect, type Page } from '@playwright/test';

const PROJECT_ID = 'e2e-daily-delta-0000-0000-0000-000000000925';
const BASE_URL = `/projects/${PROJECT_ID}/sprints`;

const ACTIVE_SPRINT = {
  id: 'sp-active', server_version: 1, short_id: 'A1', short_id_display: 'SP-A1',
  name: 'Active sprint', goal: '', start_date: '2026-04-01', finish_date: '2026-04-14',
  state: 'ACTIVE', target_milestone: null, target_milestone_detail: null,
  committed_points: 20, committed_task_count: 6, completed_points: 8, completed_task_count: 3,
  completion_ratio_points: 0.4, completion_ratio_tasks: 0.5,
  activated_at: '2026-04-01T00:00:00Z', closed_at: null,
  created_at: '2026-04-01T00:00:00Z', updated_at: '2026-04-01T00:00:00Z',
};

const DELTA = {
  sprint_id: 'sp-active',
  since: '2026-04-09T18:00:00Z',
  until: '2026-04-10T09:00:00Z',
  task_changes: [
    {
      task_id: 't1', task_short_id: 'T-1', task_title: 'Login flow', kind: 'status',
      from: 'IN_PROGRESS', to: 'REVIEW', actor_id: 4, actor_username: 'alex',
      at: '2026-04-10T08:00:00Z',
    },
  ],
  scope_added: [
    { task_id: 't3', task_short_id: 'T-3', task_title: 'Hotfix', added_by_username: 'jordan', at: '2026-04-10T07:00:00Z', status: 'PENDING' },
  ],
  new_blockers: [
    { task_id: 't2', task_short_id: 'T-2', task_title: 'Payments', actor_username: 'alex', at: '2026-04-10T08:30:00Z' },
  ],
  burndown_delta: {
    prior_date: '2026-04-09', prior_remaining: 20, current_date: '2026-04-10',
    current_remaining: 12, remaining_delta: -8, completed_delta: 8,
  },
  per_actor: [{ actor_id: 4, actor_username: 'alex', moved: 1, completed: 0, added: 0, blocked: 1 }],
};

async function setup(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });
  const json = (body: unknown, status = 200) => ({
    status, contentType: 'application/json', body: JSON.stringify(body),
  });

  // Catch-all FIRST so every specific route below wins — Playwright matches
  // routes in reverse-registration order (the last-registered handler is tried
  // first). Registered last, this would clobber the sprints-list + daily-delta
  // mocks and the active sprint would never render.
  await page.route('**/api/v1/**', (r) => r.fulfill(json({ count: 0, next: null, previous: null, results: [] })));

  await page.route('**/api/v1/projects/', (r) =>
    r.fulfill(json({ count: 1, next: null, previous: null, results: [
      { id: PROJECT_ID, name: 'Standup Project', description: '', start_date: '2026-04-01', calendar: 'default', methodology: 'AGILE' },
    ] })));
  await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (r) =>
    r.fulfill(json({ id: PROJECT_ID, server_version: 1, name: 'Standup Project', description: '', start_date: '2026-04-01', calendar: null, estimation_mode: 'open', agile_features: true, methodology: 'AGILE' })));
  await page.route(`**/api/v1/projects/${PROJECT_ID}/sprints/`, (r) =>
    r.fulfill(json({ count: 1, next: null, previous: null, results: [ACTIVE_SPRINT] })));
  await page.route(/\/api\/v1\/sprints\/.*\/daily-delta\//, (r) => r.fulfill(json(DELTA)));
  // Everything else the active-sprint view fetches → benign empty defaults.
  await page.route(/\/api\/v1\/sprints\/.*\/burndown\//, (r) => r.fulfill(json({ sprint: ACTIVE_SPRINT, snapshots: [] })));
  await page.route(/\/api\/v1\/sprints\/.*\/capacity\//, (r) => r.fulfill(json({ members: [], totals: { committed_hours: 0, available_hours: 0, ratio: 0, buffer_hours: 0, label: 'on_track', pto_days: 0 }, working_days: 0, hours_per_day: 8 })));
  await page.route(`**/api/v1/projects/${PROJECT_ID}/velocity/`, (r) => r.fulfill(json({ sprints: [], rolling_avg_points: null, rolling_stdev_points: null, forecast_range_low: null, forecast_range_high: null, rolling_avg_tasks: null, rolling_stdev_tasks: null })));
  await page.route('**/api/v1/me/active-sprints/', (r) => r.fulfill(json([])));
  await page.route('**/api/v1/projects/*/presence/', (r) => r.fulfill(json([])));
  await page.route('**/api/v1/projects/*/status-summary/', (r) => r.fulfill(json({ task_count: 0, critical_path_count: 0, monte_carlo_p80: null, at_risk_count: 0, critical_count: 0, at_risk_tasks: [], critical_tasks: [], last_saved: null, recalculated_at: null })));
  await page.route('**/api/v1/edition/', (r) => r.fulfill(json({ edition: 'community' })));
  await page.route('**/api/v1/auth/me/', (r) => r.fulfill(json({ id: 'e2e-user', username: 'e2e', display_name: 'E2E', initials: 'E', email: 'e2e@example.com' })));
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/`, (r) => r.fulfill(json([{ id: 'mem-1', role: 100 }])));
}

test.describe('Daily standup delta (#925)', () => {
  test('the active sprint shows the since-yesterday delta', async ({ page }) => {
    await setup(page);
    await page.goto(BASE_URL);

    const panel = page.getByTestId('sprint-daily-delta');
    await expect(panel).toBeVisible();
    await expect(panel.getByText(/Moved cards/i)).toBeVisible();
    await expect(panel.getByText('Login flow')).toBeVisible();
    await expect(panel.getByText(/In progress → Review/i)).toBeVisible();
    await expect(panel.getByText(/New blockers/i)).toBeVisible();
    await expect(panel.getByText('Payments')).toBeVisible();
    await expect(panel.getByText(/-8 pts remaining/i)).toBeVisible();
    // Per-actor at-a-glance — counts only, never hours.
    await expect(panel.getByText(/1 moved · 1 blocked/i)).toBeVisible();
    await expect(panel).not.toContainText(/hours|hrs/i);
  });
});
