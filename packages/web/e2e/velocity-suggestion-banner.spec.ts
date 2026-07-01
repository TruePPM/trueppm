import { test, expect, type Page } from '@playwright/test';

/**
 * E2E coverage for the velocity-calibration suggestion banner (ADR-0065, issue #498).
 *
 * Verifies that:
 *   - the banner renders in the Estimates section when a pending suggestion exists
 *   - clicking Accept fires POST /api/v1/velocity-suggestions/{id}/accept/
 *   - the banner is gated to PM-role users (membership.role >= ROLE_ADMIN)
 *
 * All API calls are intercepted with Playwright route mocking; no server required.
 */

const PROJECT_ID = 'e2e-velocity-00000000-0000-0000-0000-000000000498';

const PROJECT_DETAIL = {
  id: PROJECT_ID,
  name: 'Velocity Calibration Demo',
  description: '',
  start_date: '2026-04-01',
  calendar: 'default',
  estimation_mode: 'open',
  agile_features: true,
  methodology: 'HYBRID',
};

const TASK = {
  id: 'task-498-aaaa',
  wbs_path: '1',
  name: 'Build widget',
  early_start: '2026-04-01',
  early_finish: '2026-04-03',
  duration: 2,
  percent_complete: 0,
  is_critical: false,
  is_milestone: false,
  is_summary: false,
  parent_id: null,
  actual_start: null,
  actual_finish: null,
  schedule_variance_days: null,
  baseline_start: null,
  baseline_finish: null,
  optimistic_duration: null,
  most_likely_duration: 2,
  pessimistic_duration: null,
  estimate_status: null,
  status: 'IN_PROGRESS',
  planned_start: null,
  assignments: [],
  story_points: 6,
  sprint: 'sprint-12',
};

const PENDING_SUGGESTION = {
  id: 'sugg-498-bbbb',
  task: TASK.id,
  sprint_id: 'sprint-12',
  sprint_name: 'Sprint 12',
  suggested_duration: 4,
  team_velocity_per_day: '1.500',
  flag_for_review: false,
  is_pending: true,
  created_at: '2026-05-01T00:00:00Z',
  accepted_at: null,
  accepted_by: null,
  dismissed_at: null,
  dismissed_by: null,
};

async function setupScheduleWithPendingSuggestion(
  page: Page,
  opts: { role: number } = { role: 300 },
) {
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
      body: JSON.stringify({ count: 1, next: null, previous: null, results: [PROJECT_DETAIL] }),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PROJECT_DETAIL) }),
  );
  await page.route('**/api/v1/projects/*/presence/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  await page.route('**/api/v1/projects/*/status-summary/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        task_count: 1, critical_path_count: 0, monte_carlo_p80: null,
        at_risk_count: 0, critical_count: 0, at_risk_tasks: [], critical_tasks: [],
        last_saved: null, recalculated_at: null,
      }),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/overview/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        schedule_health: 'unknown', spi: null, tasks_late_count: 0,
        critical_task_count: 0, total_tasks: 1, complete_tasks: 0,
        next_milestone: null, team_utilization_pct: null, owner_name: null,
        start_date: '2026-04-01',
      }),
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
      body: JSON.stringify({ count: 1, next: null, previous: null, results: [TASK] }),
    }),
  );
  await page.route('**/api/v1/dependencies/**', (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
  await page.route('**/api/v1/task-resources/**', (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
  await page.route('**/api/v1/resources/**', (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
  await page.route('**/tasks/*/history/**', (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
  await page.route('**/tasks/*/baseline/**', (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ has_baseline: false }),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/sprints/`, (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ count: 1, next: null, previous: null, results: [] }),
    }),
  );
  await page.route('**/api/v1/me/active-sprints/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  await page.route('**/api/v1/auth/me/', (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        id: 'e2e-user', username: 'pm', display_name: 'PM', initials: 'P', email: 'pm@example.com',
      }),
    }),
  );
  // Use `members/**` to match `?self=true` query string used by useCurrentUserRole.
  // Both list and self-check paths return the same single-row array; the hook reads
  // res.data[0] so the array shape is valid for both.
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/**`, (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify([{ id: 'mem-1', role: opts.role }]),
    }),
  );
  await page.route('**/api/v1/edition/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ edition: 'community' }) }),
  );

  // Velocity-suggestion endpoints — the surface under test. Stateful: the
  // pending row drops out of the ?pending=true list once accepted or dismissed,
  // exactly as the server does when the decision is recorded. Without this the
  // GET returns the pending row forever and the banner is never proven to clear,
  // so a deleted onSuccess invalidation ships green (issue 1512).
  let pending = true;
  await page.route('**/api/v1/velocity-suggestions/**', (route) => {
    const url = route.request().url();
    const method = route.request().method();
    if (method === 'POST' && url.includes('/accept/')) {
      pending = false;
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          ...PENDING_SUGGESTION,
          is_pending: false,
          accepted_at: '2026-05-02T00:00:00Z',
          accepted_by: 'e2e-user',
        }),
      });
    }
    if (method === 'POST' && url.includes('/dismiss/')) {
      pending = false;
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          ...PENDING_SUGGESTION,
          is_pending: false,
          dismissed_at: '2026-05-02T00:00:00Z',
          dismissed_by: 'e2e-user',
        }),
      });
    }
    // GET list (?pending=true) — empty once a decision has been recorded.
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        count: pending ? 1 : 0,
        next: null,
        previous: null,
        results: pending ? [PENDING_SUGGESTION] : [],
      }),
    });
  });
}

async function openEstimates(page: Page) {
  const grid = page.getByRole('grid', { name: 'Task list' });
  await expect(grid).toBeVisible({ timeout: 10_000 });
  await grid.getByText(TASK.name, { exact: true }).click();
  const drawer = page.getByRole('dialog', { name: new RegExp(TASK.name) }).first();
  await expect(drawer).toBeVisible({ timeout: 5_000 });
  await drawer.getByRole('button', { name: 'Estimates' }).click();
  return drawer;
}

test.describe('Velocity calibration suggestion banner (ADR-0065 / #498)', () => {
  test('PM sees the banner and Accept POSTs to the accept endpoint', async ({ page }) => {
    await setupScheduleWithPendingSuggestion(page, { role: 300 });
    await page.goto(`/projects/${PROJECT_ID}/schedule`);

    const drawer = await openEstimates(page);

    const banner = drawer.getByLabel(/Velocity calibration suggestion/i);
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(/Sprint 12/);
    await expect(banner).toContainText(/4d/);

    const acceptRequest = page.waitForRequest(
      (req) =>
        req.url().includes(`/api/v1/velocity-suggestions/${PENDING_SUGGESTION.id}/accept/`) &&
        req.method() === 'POST',
    );
    await banner.getByRole('button', { name: /Accept/ }).click();
    await acceptRequest;

    // The banner clears once the accepted suggestion leaves the pending list —
    // proving onSuccess invalidated the query and refetched, not merely that
    // the POST fired.
    await expect(drawer.getByLabel(/Velocity calibration suggestion/i)).toHaveCount(0);
  });

  test('Dismiss button posts to the dismiss endpoint', async ({ page }) => {
    await setupScheduleWithPendingSuggestion(page, { role: 300 });
    await page.goto(`/projects/${PROJECT_ID}/schedule`);
    const drawer = await openEstimates(page);

    const banner = drawer.getByLabel(/Velocity calibration suggestion/i);
    await expect(banner).toBeVisible();

    const dismissRequest = page.waitForRequest(
      (req) =>
        req.url().includes(`/api/v1/velocity-suggestions/${PENDING_SUGGESTION.id}/dismiss/`) &&
        req.method() === 'POST',
    );
    await banner.getByRole('button', { name: /Dismiss/ }).click();
    await dismissRequest;

    // The banner clears once the dismissed suggestion leaves the pending list.
    await expect(drawer.getByLabel(/Velocity calibration suggestion/i)).toHaveCount(0);
  });

  test('non-admin (Team Member) does not see the banner', async ({ page }) => {
    await setupScheduleWithPendingSuggestion(page, { role: 100 });
    await page.goto(`/projects/${PROJECT_ID}/schedule`);
    const drawer = await openEstimates(page);

    await expect(drawer.getByLabel(/Velocity calibration suggestion/i)).toHaveCount(0);
  });
});
