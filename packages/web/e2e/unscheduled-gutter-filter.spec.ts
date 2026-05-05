import { test, expect } from '@playwright/test';

/**
 * E2E for the Unscheduled gutter filter rules introduced in issue #317:
 * - BACKLOG cards never appear in the gutter (they live on the board)
 * - NOT_STARTED + no start + no sprint → in the gutter
 * - NOT_STARTED + sprint → excluded (sprint is a scheduling commitment)
 * - IN_PROGRESS / REVIEW / COMPLETE without start → not in gutter, but render
 *   a `⚠ missing dates` data-integrity chip on the task list row
 */

const FIXTURE_PROJECT_ID = 'e2e-fixture-00000000-0000-0000-0000-000000000001';

const FIXTURE_API_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Gutter Filter Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

function task(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: '', wbs_path: '', name: '',
    early_start: null, early_finish: null,
    planned_start: null, duration: 5, percent_complete: 0,
    is_critical: false, is_milestone: false, is_summary: false,
    parent_id: null, status: 'NOT_STARTED',
    actual_start: null, actual_finish: null, schedule_variance_days: null,
    baseline_start: null, baseline_finish: null,
    optimistic_duration: null, most_likely_duration: null, pessimistic_duration: null,
    estimate_status: null, total_float: null,
    assignee_is_overallocated: false, assignments: [],
    sprint: null,
    ...over,
  };
}

const FIXTURE_TASKS = [
  // Scheduled — provides a non-empty Gantt + a row in the task list.
  task({ id: 't-scheduled', wbs_path: '1', name: 'Scheduled Item',
    early_start: '2026-04-07', early_finish: '2026-04-21', duration: 14,
    status: 'IN_PROGRESS', percent_complete: 30 }),
  // BACKLOG idea — must NOT appear in the gutter.
  task({ id: 't-backlog', wbs_path: '2', name: 'Backlog Idea',
    status: 'BACKLOG' }),
  // NOT_STARTED, no sprint, no dates — SHOULD appear in the gutter.
  task({ id: 't-todo', wbs_path: '3', name: 'Ready For Schedule',
    status: 'NOT_STARTED' }),
  // NOT_STARTED + sprint — sprint is the scheduling commitment; NOT in gutter.
  task({ id: 't-sprint', wbs_path: '4', name: 'Committed To Sprint',
    status: 'NOT_STARTED', sprint: 'sprint-uuid-1' }),
  // IN_PROGRESS without dates — data integrity warning chip on the row, NOT in gutter.
  task({ id: 't-broken', wbs_path: '5', name: 'In Progress No Dates',
    status: 'IN_PROGRESS', percent_complete: 25 }),
];

async function setupRoutes(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.removeItem('trueppm.gantt.unscheduledGutter.collapsed');
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
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ count: 1, next: null, previous: null, results: FIXTURE_API_PROJECTS }),
    }),
  );
  await page.route('**/api/v1/projects/*/presence/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  await page.route('**/api/v1/projects/*/status-summary/', (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        task_count: FIXTURE_TASKS.length, critical_path_count: 0, monte_carlo_p80: null,
        at_risk_count: 0, critical_count: 0, at_risk_tasks: [], critical_tasks: [],
        last_saved: null, recalculated_at: null,
      }),
    }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/overview/`, (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        schedule_health: 'unknown', spi: null, tasks_late_count: 0, critical_task_count: 0,
        total_tasks: FIXTURE_TASKS.length, complete_tasks: 0, next_milestone: null,
        team_utilization_pct: null, owner_name: null, start_date: '2026-04-01',
      }),
    }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/attention/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/my-tasks/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tasks: [] }) }),
  );
  await page.route('**/api/v1/tasks/**', (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        count: FIXTURE_TASKS.length, next: null, previous: null, results: FIXTURE_TASKS,
      }),
    }),
  );
  await page.route('**/api/v1/dependencies/**', (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
}

async function gotoSchedule(page: import('@playwright/test').Page) {
  await setupRoutes(page);
  await page.goto(`/projects/${FIXTURE_PROJECT_ID}/schedule`);
  await expect(page.getByRole('grid', { name: 'Task list' })).toBeVisible({ timeout: 10_000 });
}

test.describe('Unscheduled gutter — filter rules (#317)', () => {
  test('BACKLOG ideas are excluded from the gutter', async ({ page }) => {
    await gotoSchedule(page);
    const gutter = page.getByRole('region', { name: 'Unscheduled tasks' });
    await expect(gutter.getByText('Backlog Idea')).toHaveCount(0);
  });

  test('NOT_STARTED with no sprint and no dates appears in the gutter', async ({ page }) => {
    await gotoSchedule(page);
    const gutter = page.getByRole('region', { name: 'Unscheduled tasks' });
    await expect(gutter.getByText('Ready For Schedule')).toBeVisible();
  });

  test('NOT_STARTED assigned to a sprint is excluded from the gutter', async ({ page }) => {
    await gotoSchedule(page);
    const gutter = page.getByRole('region', { name: 'Unscheduled tasks' });
    await expect(gutter.getByText('Committed To Sprint')).toHaveCount(0);
  });

  test('gutter count reflects only the eligible NOT_STARTED set', async ({ page }) => {
    await gotoSchedule(page);
    // Of the 5 fixtures, only "Ready For Schedule" qualifies → count is 1.
    await expect(page.getByText('(1)')).toBeVisible();
  });
});

test.describe('Unscheduled gutter — data integrity chip (#317)', () => {
  test('IN_PROGRESS task with no dates renders the missing-dates chip in the task list', async ({ page }) => {
    await gotoSchedule(page);
    // Chip lives on the task list row, not in the unscheduled gutter region.
    const chip = page.getByLabel('Missing schedule dates').first();
    await expect(chip).toBeVisible();
  });

  test('IN_PROGRESS task with no dates is NOT in the unscheduled gutter', async ({ page }) => {
    await gotoSchedule(page);
    const gutter = page.getByRole('region', { name: 'Unscheduled tasks' });
    await expect(gutter.getByText('In Progress No Dates')).toHaveCount(0);
  });

  test('scheduled task does not render the missing-dates chip', async ({ page }) => {
    await gotoSchedule(page);
    // Locate the row by its task name and assert the chip is absent within it.
    const scheduledRow = page.getByRole('row').filter({ hasText: 'Scheduled Item' });
    await expect(scheduledRow.getByTestId('missing-dates-chip')).toHaveCount(0);
  });
});
