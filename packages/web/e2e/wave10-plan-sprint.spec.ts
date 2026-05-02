/**
 * Plan Sprint modal E2E (gap from #227).
 *
 * Verifies that clicking "Plan next sprint" in the Sprints view header
 * opens the dialog, the form submits to the create endpoint, and the
 * dialog closes on success.
 */
import { test, expect } from '@playwright/test';

const PROJECT_ID = 'e2e-plan-sprint-00000000-0000-0000-0000-000000000050';
const BASE_URL = `/projects/${PROJECT_ID}/sprints`;

const FIXTURE_PROJECTS = [
  { id: PROJECT_ID, name: 'Plan Sprint Project', description: '', start_date: '2026-04-01', calendar: 'default', methodology: 'AGILE' },
];

const PROJECT_DETAIL = {
  id: PROJECT_ID, server_version: 1, name: 'Plan Sprint Project',
  description: '', start_date: '2026-04-01', calendar: null,
  estimation_mode: 'open', agile_features: true, methodology: 'AGILE',
};

const ACTIVE_SPRINT = {
  id: 'sp-active', server_version: 1, short_id: 'A1', short_id_display: 'SP-A1',
  name: 'Active sprint', goal: '', start_date: '2026-04-01', finish_date: '2026-04-14',
  state: 'ACTIVE',
  target_milestone: null, target_milestone_detail: null,
  committed_points: 20, committed_task_count: 0,
  completed_points: 0, completed_task_count: 0,
  completion_ratio_points: 0, completion_ratio_tasks: 0,
  activated_at: '2026-04-01T00:00:00Z', closed_at: null,
  created_at: '2026-04-01T00:00:00Z', updated_at: '2026-04-01T00:00:00Z',
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
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 1, next: null, previous: null, results: FIXTURE_PROJECTS }) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PROJECT_DETAIL) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/sprints/`, (route) => {
    if (route.request().method() === 'POST') {
      const created = {
        ...ACTIVE_SPRINT,
        id: 'sp-new', short_id: 'B2', short_id_display: 'SP-B2',
        state: 'PLANNED', name: 'Sprint 2 — Pilot deployment',
        start_date: '2026-04-15', finish_date: '2026-04-28',
      };
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(created) });
    }
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ count: 1, next: null, previous: null, results: [ACTIVE_SPRINT] }),
    });
  });
  await page.route(/\/api\/v1\/sprints\/.*\/burndown\//, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sprint: ACTIVE_SPRINT, snapshots: [] }) }),
  );
  await page.route(/\/api\/v1\/sprints\/.*\/capacity\//, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      members: [], totals: { committed_hours: 0, available_hours: 0, ratio: 0, buffer_hours: 0, label: 'on_track', pto_days: 0 },
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
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
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
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'mem-1', role: 3 }]) }),
  );
}

test.describe('Plan Sprint modal', () => {
  test('opens the modal, submits a create payload, and closes on success', async ({ page }) => {
    await setupCommon(page);

    // Capture the POST payload for assertion.
    const postPromise = page.waitForRequest((req) =>
      req.url().includes(`/api/v1/projects/${PROJECT_ID}/sprints/`) && req.method() === 'POST',
    );

    await page.goto(BASE_URL);

    await page.getByRole('button', { name: /^Plan next sprint$/i }).click();
    const dialog = page.getByRole('dialog', { name: /Plan next sprint/i });
    await expect(dialog).toBeVisible();

    await dialog.getByRole('textbox', { name: /^Name/i }).fill('Sprint 2 — Pilot deployment');
    await dialog.getByRole('textbox', { name: /^Goal/i }).fill('Roll out to internal users');

    await dialog.getByRole('button', { name: /Plan sprint/i }).click();

    const post = await postPromise;
    const body = post.postDataJSON() as Record<string, unknown>;
    expect(body.name).toBe('Sprint 2 — Pilot deployment');
    expect(body.goal).toBe('Roll out to internal users');
    expect(body.start_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.finish_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    await expect(dialog).not.toBeVisible();
  });

  test('shows validation alert when finish date is on or before start', async ({ page }) => {
    await setupCommon(page);
    await page.goto(BASE_URL);

    await page.getByRole('button', { name: /^Plan next sprint$/i }).click();
    const dialog = page.getByRole('dialog', { name: /Plan next sprint/i });
    await dialog.getByLabel(/^Start/i).fill('2026-05-10');
    await dialog.getByLabel(/^Finish/i).fill('2026-05-01');
    await expect(dialog.getByRole('alert')).toContainText(/Finish date must be after start date/i);
    await expect(dialog.getByRole('button', { name: /Plan sprint/i })).toBeDisabled();
  });
});
