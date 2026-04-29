import { test, expect } from '@playwright/test';

/**
 * E2E tests for wave 3 task drawer header section (#210):
 * - Owner row: assignee name + avatar initials; "Unassigned" fallback
 * - Over-allocated pill (passive amber ⚠) when assignee_is_overallocated is true
 * - Date row: early_start → early_finish with baseline row when present
 * - Float row: "Nd float"; red + "· critical path" for 0d critical tasks
 * - "Not scheduled" for tasks with no start date
 *
 * Builds on the existing task-detail-drawer spec — covers only wave 3 header additions.
 */

const FIXTURE_PROJECT_ID = 'e2e-fixture-00000000-0000-0000-0000-000000000001';

const FIXTURE_API_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Task Drawer Test Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
    estimation_mode: 'open',
  },
];

const FIXTURE_API_TASKS = [
  {
    // Task with assignee, overalloc, float, baseline
    id: 't1', wbs_path: '1', name: 'Design Sprint',
    early_start: '2026-04-07', early_finish: '2026-04-21',
    planned_start: null, duration: 14, percent_complete: 50,
    is_critical: false, is_milestone: false, is_summary: false,
    parent_id: null, status: 'IN_PROGRESS',
    actual_start: null, actual_finish: null, schedule_variance_days: null,
    baseline_start: '2026-04-05', baseline_finish: '2026-04-19',
    optimistic_duration: null, most_likely_duration: null, pessimistic_duration: null,
    estimate_status: null, total_float: 3,
    assignee_is_overallocated: true,
    assignments: [{ resource_id: 'r1', resource_name: 'Jane Smith', units: 0.8 }],
  },
  {
    // Task with no assignee (Unassigned fallback)
    id: 't2', wbs_path: '2', name: 'Backend Implementation',
    early_start: '2026-04-14', early_finish: '2026-04-28',
    planned_start: null, duration: 10, percent_complete: 0,
    is_critical: true, is_milestone: false, is_summary: false,
    parent_id: null, status: 'NOT_STARTED',
    actual_start: null, actual_finish: null, schedule_variance_days: null,
    baseline_start: null, baseline_finish: null,
    optimistic_duration: null, most_likely_duration: null, pessimistic_duration: null,
    estimate_status: null, total_float: 0,
    assignee_is_overallocated: false,
    assignments: [],
  },
  {
    // Unscheduled task — "Not scheduled" in header
    id: 't3', wbs_path: '3', name: 'Parking Lot Item',
    early_start: null, early_finish: null,
    planned_start: null, duration: 5, percent_complete: 0,
    is_critical: false, is_milestone: false, is_summary: false,
    parent_id: null, status: 'BACKLOG',
    actual_start: null, actual_finish: null, schedule_variance_days: null,
    baseline_start: null, baseline_finish: null,
    optimistic_duration: null, most_likely_duration: null, pessimistic_duration: null,
    estimate_status: null, total_float: null,
    assignee_is_overallocated: false,
    assignments: [],
  },
];

const FIXTURE_HISTORY = {
  count: 0, next: null, previous: null, results: [],
};

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
        task_count: 3, critical_path_count: 1, monte_carlo_p80: null,
        at_risk_count: 0, critical_count: 1, at_risk_tasks: [], critical_tasks: [],
        last_saved: null, recalculated_at: null,
      }),
    }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/overview/`, (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ schedule_health: 'unknown', spi: null, tasks_late_count: 0, critical_task_count: 0, total_tasks: 3, complete_tasks: 0, next_milestone: null, team_utilization_pct: null, owner_name: null, start_date: '2026-01-01' }),
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
      body: JSON.stringify({ count: FIXTURE_API_TASKS.length, next: null, previous: null, results: FIXTURE_API_TASKS }),
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
  await page.route(`**/tasks/*/history/**`, (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify(FIXTURE_HISTORY),
    }),
  );
  await page.route(`**/tasks/*/baseline/**`, (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ has_baseline: false }),
    }),
  );

  await page.goto(`/projects/${FIXTURE_PROJECT_ID}/schedule`);
}

async function openDrawer(page: import('@playwright/test').Page, taskName: string) {
  const grid = page.getByRole('grid', { name: 'Task list' });
  await expect(grid).toBeVisible({ timeout: 10_000 });
  await grid.getByText(taskName, { exact: true }).click();
  const drawer = page.getByRole('dialog', { name: new RegExp(taskName) });
  await expect(drawer).toBeVisible({ timeout: 5_000 });
  return drawer;
}

// ---------------------------------------------------------------------------
// Owner row
// ---------------------------------------------------------------------------

test.describe('TaskDetailDrawer header — owner row (#210)', () => {
  test.beforeEach(async ({ page }) => {
    await gotoSchedule(page);
  });

  test('renders assignee name in owner row', async ({ page }) => {
    const drawer = await openDrawer(page, 'Design Sprint');
    await expect(drawer.getByText('Jane Smith')).toBeVisible();
  });

  test('renders "Unassigned" when task has no assignees', async ({ page }) => {
    const drawer = await openDrawer(page, 'Backend Implementation');
    await expect(drawer.getByText('Unassigned')).toBeVisible();
  });

  test('renders over-allocated pill when assignee_is_overallocated is true', async ({ page }) => {
    const drawer = await openDrawer(page, 'Design Sprint');
    await expect(drawer.getByText('⚠ over-allocated')).toBeVisible();
  });

  test('does not render over-allocated pill when not overallocated', async ({ page }) => {
    const drawer = await openDrawer(page, 'Backend Implementation');
    await expect(drawer.getByText('⚠ over-allocated')).not.toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Date row
// ---------------------------------------------------------------------------

test.describe('TaskDetailDrawer header — date row (#210)', () => {
  test.beforeEach(async ({ page }) => {
    await gotoSchedule(page);
  });

  test('renders start and finish dates', async ({ page }) => {
    const drawer = await openDrawer(page, 'Design Sprint');
    // early_start: 2026-04-07 → "Apr 7"; early_finish: 2026-04-21 → "Apr 21"
    await expect(drawer.getByText(/Apr 7/)).toBeVisible();
    await expect(drawer.getByText(/Apr 21/)).toBeVisible();
  });

  test('renders baseline dates when present', async ({ page }) => {
    const drawer = await openDrawer(page, 'Design Sprint');
    // baseline_start: 2026-04-05 → "BL: Apr 5 → Apr 19" row
    await expect(drawer.getByText(/BL:/)).toBeVisible();
  });

  test('does not render baseline row when baseline is absent', async ({ page }) => {
    const drawer = await openDrawer(page, 'Backend Implementation');
    await expect(drawer.getByText(/BL:/)).not.toBeVisible();
  });

  test('renders "Not scheduled" for tasks with no start date', async ({ page }) => {
    const drawer = await openDrawer(page, 'Parking Lot Item');
    await expect(drawer.getByText('Not scheduled')).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Float row
// ---------------------------------------------------------------------------

test.describe('TaskDetailDrawer header — float row (#210)', () => {
  test.beforeEach(async ({ page }) => {
    await gotoSchedule(page);
  });

  test('renders float value', async ({ page }) => {
    const drawer = await openDrawer(page, 'Design Sprint');
    await expect(drawer.getByText('3d float')).toBeVisible();
  });

  test('renders 0d float with critical path indicator for critical task', async ({ page }) => {
    const drawer = await openDrawer(page, 'Backend Implementation');
    await expect(drawer.getByText('0d float')).toBeVisible();
    await expect(drawer.getByText('· critical path')).toBeVisible();
  });

  test('renders "Float pending" when total_float is null', async ({ page }) => {
    const drawer = await openDrawer(page, 'Parking Lot Item');
    await expect(drawer.getByText(/Float pending/)).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Tab bar still present (header does not replace tabs)
// ---------------------------------------------------------------------------

test.describe('TaskDetailDrawer header — tab bar still present (#210)', () => {
  test.beforeEach(async ({ page }) => {
    await gotoSchedule(page);
  });

  test('all four tabs are visible after header renders', async ({ page }) => {
    const drawer = await openDrawer(page, 'Design Sprint');
    await expect(drawer.getByRole('tab', { name: 'Dependencies' })).toBeVisible();
    await expect(drawer.getByRole('tab', { name: 'Estimates' })).toBeVisible();
    await expect(drawer.getByRole('tab', { name: 'History' })).toBeVisible();
    await expect(drawer.getByRole('tab', { name: 'Baseline' })).toBeVisible();
  });

  test('header renders above the tab bar (DOM order)', async ({ page }) => {
    const drawer = await openDrawer(page, 'Design Sprint');
    // The assignee name must be in the drawer before the tab bar
    const assigneeEl = drawer.getByText('Jane Smith');
    const tabBar = drawer.getByRole('tablist');
    await expect(assigneeEl).toBeVisible();
    await expect(tabBar).toBeVisible();
    // Confirm DOM order: assignee appears before tabs
    const assigneeBox = await assigneeEl.boundingBox();
    const tabBarBox = await tabBar.boundingBox();
    expect(assigneeBox!.y).toBeLessThan(tabBarBox!.y);
  });
});
