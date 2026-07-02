import { test, expect } from '@playwright/test';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * Schedule Grid ↔ Timeline view toggle E2E (#1221, v2 redesign epic #1163).
 *
 * Grid mode shows the WBS task-list table (role="grid", name "Task list")
 * beside the timeline; Timeline mode hides it for a full-width canvas. The
 * choice persists per-user in localStorage.
 */

const FIXTURE_PROJECT_ID = 'e2e-fixture-00000000-0000-0000-0000-000000000001';

const FIXTURE_API_PROJECTS = [
  { id: FIXTURE_PROJECT_ID, name: 'Alpha Platform Upgrade', description: '', start_date: '2026-01-01', calendar: 'default' },
];

const FIXTURE_API_TASKS = [
  {
    id: 't1', wbs_path: '1', name: 'Alpha Platform Upgrade',
    early_start: '2026-10-05', early_finish: '2026-11-14',
    duration: 30, percent_complete: 40, is_critical: false, is_milestone: false,
    status: 'IN_PROGRESS', is_summary: false, parent_id: null,
  },
  {
    id: 't2', wbs_path: '1.1', name: 'Discovery & Design',
    early_start: '2026-10-05', early_finish: '2026-10-16',
    duration: 10, percent_complete: 100, is_critical: true, is_milestone: false,
    status: 'COMPLETE', is_summary: false, parent_id: null,
  },
  {
    id: 't3', wbs_path: '1.2', name: 'Backend Implementation',
    early_start: '2026-10-19', early_finish: '2026-10-30',
    duration: 10, percent_complete: 60, is_critical: true, is_milestone: false,
    status: 'IN_PROGRESS', is_summary: false, parent_id: null,
  },
];

async function gotoSchedule(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });
  // 401-guard catch-all (CLAUDE.md): registered FIRST so the specific routes
  // below take priority (Playwright tries the most-recently-added match first).
  // Any endpoint not explicitly mocked returns an empty list shape rather than a
  // 401 that would trip the "Your session expired" modal mid-test. The Schedule
  // page's object-shaped endpoints (overview, status-summary) are all mocked
  // explicitly below, so the list shape never reaches a component that expects
  // an object.
  // Shared 404 catch-all (issue 1513): unmocked endpoints 404 loudly instead of
  // being masked by a permissive 200-list body (the #1190 flake class).
  await setupCatchAll(page);
  await page.route('**/api/v1/projects/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: FIXTURE_API_PROJECTS.length, next: null, previous: null, results: FIXTURE_API_PROJECTS }) }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: FIXTURE_PROJECT_ID, name: 'Alpha Platform Upgrade', description: '', start_date: '2026-01-01', calendar: 'default', estimation_mode: 'OPEN', agile_features: false, methodology: 'HYBRID', code: '', health: 'AUTO', visibility: 'WORKSPACE', timezone: '', default_view: 'SCHEDULE', lead: null, lead_detail: null, iteration_label: 'Sprint', is_archived: false, archived_at: null, archived_by: null, recalculated_at: null, is_sample: false, program_detail: null, server_version: 1 }) }),
  );
  await page.route('**/api/v1/projects/*/presence/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  await page.route('**/api/v1/projects/*/status-summary/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ task_count: 0, critical_path_count: 0, monte_carlo_p80: null, at_risk_count: 0, critical_count: 0, at_risk_tasks: [], critical_tasks: [], last_saved: null, recalculated_at: null }) }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/overview/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ schedule_health: 'unknown', spi: null, tasks_late_count: 0, critical_task_count: 0, total_tasks: 0, complete_tasks: 0, next_milestone: null, team_utilization_pct: null, owner_name: null, start_date: '2026-01-01' }) }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/attention/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/my-tasks/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tasks: [] }) }),
  );
  await page.route('**/api/v1/tasks/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: FIXTURE_API_TASKS.length, next: null, previous: null, results: FIXTURE_API_TASKS }) }),
  );
  await page.route('**/api/v1/dependencies/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }) }),
  );
  // The socket mints a single-use ticket first (ADR-0141, #818).
  await page.route('**/api/v1/ws/ticket/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ticket: 'e2e-ticket', expires_in: 30 }) }),
  );
  await page.routeWebSocket('**/ws/v1/projects/**', () => {
    /* accept and hold open */
  });
  await page.goto(`/projects/${FIXTURE_PROJECT_ID}/schedule`);
}

test.describe('Schedule Grid ↔ Timeline toggle (#1221)', () => {
  test.beforeEach(async ({ page }) => {
    await gotoSchedule(page);
    await expect(page.getByRole('grid', { name: 'Task list' })).toBeVisible({ timeout: 10_000 });
  });

  test('defaults to Grid with the WBS task list visible', async ({ page }) => {
    const group = page.getByRole('radiogroup', { name: 'Schedule layout' });
    await expect(group).toBeVisible();
    await expect(group.getByRole('radio', { name: 'Grid' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('grid', { name: 'Task list' })).toBeVisible();
  });

  test('switching to Timeline hides the WBS task list; switching back restores it', async ({
    page,
  }) => {
    const group = page.getByRole('radiogroup', { name: 'Schedule layout' });

    await group.getByRole('radio', { name: 'Timeline' }).click();
    await expect(group.getByRole('radio', { name: 'Timeline' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(page.getByRole('grid', { name: 'Task list' })).toHaveCount(0);

    await group.getByRole('radio', { name: 'Grid' }).click();
    await expect(page.getByRole('grid', { name: 'Task list' })).toBeVisible();
  });

  test('Timeline choice is written to localStorage for cross-session persistence', async ({
    page,
  }) => {
    // The reload round-trip itself is exercised by the scheduleStore unit test
    // (readViewMode/setViewMode); asserting it via page.reload() here is flaky
    // because the post-reload task fetch can race the auth re-seed and trip the
    // session-expired modal (documented in CLAUDE.md). Verify the persisted
    // value directly instead.
    await page
      .getByRole('radiogroup', { name: 'Schedule layout' })
      .getByRole('radio', { name: 'Timeline' })
      .click();
    await expect(page.getByRole('grid', { name: 'Task list' })).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('schedule.viewMode')))
      .toBe('timeline');
  });
});
