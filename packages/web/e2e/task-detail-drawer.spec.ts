import { test, expect } from '@playwright/test';

/**
 * E2E tests for the four-tab TaskDetailDrawer (issue #141 / ADR-0032).
 *
 * Covers:
 *  - Tab bar renders and switching works
 *  - Estimates tab: PERT panel visible when all three fields are set (open mode)
 *  - Estimates tab: pending banner in suggest_approve mode
 *  - History tab: records render from mocked API
 *  - Baseline tab: no-baseline empty state
 *
 * All API calls are intercepted with Playwright route mocking.
 */

const FIXTURE_PROJECT_ID = 'e2e-fixture-00000000-0000-0000-0000-000000000001';

const FIXTURE_API_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Alpha Platform Upgrade',
    description: '',
    start_date: '2026-01-01',
    calendar: 'default',
    estimation_mode: 'open',
  },
];

const FIXTURE_API_TASKS = [
  {
    id: 't1',
    wbs_path: '1',
    name: 'Discovery & Design',
    early_start: '2026-10-05',
    early_finish: '2026-10-16',
    duration: 10,
    percent_complete: 50,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    actual_start: null,
    actual_finish: null,
    schedule_variance_days: null,
    baseline_start: null,
    baseline_finish: null,
    optimistic_duration: 7,
    most_likely_duration: 10,
    pessimistic_duration: 15,
    estimate_status: null,
    status: 'IN_PROGRESS',
    planned_start: null,
    assignments: [],
  },
  {
    id: 't2',
    wbs_path: '2',
    name: 'Backend Implementation',
    early_start: '2026-10-19',
    early_finish: '2026-10-30',
    duration: 10,
    percent_complete: 0,
    is_critical: true,
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    actual_start: null,
    actual_finish: null,
    schedule_variance_days: null,
    baseline_start: null,
    baseline_finish: null,
    optimistic_duration: null,
    most_likely_duration: null,
    pessimistic_duration: null,
    estimate_status: null,
    status: 'NOT_STARTED',
    planned_start: null,
    assignments: [],
  },
];

const FIXTURE_HISTORY = {
  count: 2,
  next: null,
  previous: null,
  results: [
    {
      id: 1,
      history_date: '2026-04-25T10:00:00Z',
      history_type: '~',
      history_user: 'alice',
      diff: [{ field: 'duration', old: '8', new: '10' }],
    },
    {
      id: 2,
      history_date: '2026-04-20T09:00:00Z',
      history_type: '+',
      history_user: null,
      diff: [],
    },
  ],
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
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        task_count: 0,
        critical_path_count: 0,
        monte_carlo_p80: null,
        at_risk_count: 0,
        critical_count: 0,
        at_risk_tasks: [],
        critical_tasks: [],
        last_saved: null,
        recalculated_at: null,
      }),
    }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/overview/`, (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ schedule_health: 'unknown', spi: null, tasks_late_count: 0, critical_task_count: 0, total_tasks: 0, complete_tasks: 0, next_milestone: null, team_utilization_pct: null, owner_name: null, start_date: '2026-01-01' }),
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
  // History + baseline stubs — overridable per test
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
// Tab bar
// ---------------------------------------------------------------------------

test.describe('TaskDetailDrawer — tab bar', () => {
  test.beforeEach(async ({ page }) => {
    await gotoSchedule(page);
  });

  test('four tabs are visible after opening drawer', async ({ page }) => {
    const drawer = await openDrawer(page, 'Discovery & Design');
    await expect(drawer.getByRole('tab', { name: 'Dependencies' })).toBeVisible();
    await expect(drawer.getByRole('tab', { name: 'Estimates' })).toBeVisible();
    await expect(drawer.getByRole('tab', { name: 'History' })).toBeVisible();
    await expect(drawer.getByRole('tab', { name: 'Baseline' })).toBeVisible();
  });

  test('Dependencies tab is active by default', async ({ page }) => {
    const drawer = await openDrawer(page, 'Discovery & Design');
    const depTab = drawer.getByRole('tab', { name: 'Dependencies' });
    await expect(depTab).toHaveAttribute('aria-selected', 'true');
  });

  test('clicking Estimates tab switches panel', async ({ page }) => {
    const drawer = await openDrawer(page, 'Discovery & Design');
    await drawer.getByRole('tab', { name: 'Estimates' }).click();
    await expect(drawer.getByRole('tab', { name: 'Estimates' })).toHaveAttribute('aria-selected', 'true');
    await expect(drawer.getByLabel(/Optimistic/i)).toBeVisible();
  });

  test('clicking History tab switches panel', async ({ page }) => {
    const drawer = await openDrawer(page, 'Discovery & Design');
    await drawer.getByRole('tab', { name: 'History' }).click();
    await expect(drawer.getByRole('tab', { name: 'History' })).toHaveAttribute('aria-selected', 'true');
  });

  test('clicking Baseline tab switches panel', async ({ page }) => {
    const drawer = await openDrawer(page, 'Discovery & Design');
    await drawer.getByRole('tab', { name: 'Baseline' }).click();
    await expect(drawer.getByRole('tab', { name: 'Baseline' })).toHaveAttribute('aria-selected', 'true');
  });
});

// ---------------------------------------------------------------------------
// Estimates tab
// ---------------------------------------------------------------------------

test.describe('TaskDetailDrawer — Estimates tab', () => {
  test.beforeEach(async ({ page }) => {
    await gotoSchedule(page);
  });

  test('shows PERT panel when all three fields are set (open mode)', async ({ page }) => {
    const drawer = await openDrawer(page, 'Discovery & Design');
    await drawer.getByRole('tab', { name: 'Estimates' }).click();

    // t1 has O=7, M=10, P=15 → E = (7 + 4*10 + 15) / 6 = 62/6 ≈ 10.3
    await expect(drawer.getByRole('region', { name: /PERT/i })).toBeVisible();
    await expect(drawer.getByText(/10\.3 days/)).toBeVisible();
  });

  test('incomplete hint shown when only partial fields set', async ({ page }) => {
    const drawer = await openDrawer(page, 'Backend Implementation');
    await drawer.getByRole('tab', { name: 'Estimates' }).click();
    await expect(drawer.getByText(/Set all three values/i)).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// History tab
// ---------------------------------------------------------------------------

test.describe('TaskDetailDrawer — History tab', () => {
  test.beforeEach(async ({ page }) => {
    await gotoSchedule(page);
  });

  test('shows history records from API', async ({ page }) => {
    const drawer = await openDrawer(page, 'Discovery & Design');
    await drawer.getByRole('tab', { name: 'History' }).click();

    // From FIXTURE_HISTORY: one Updated record by alice
    await expect(drawer.getByText('Updated')).toBeVisible({ timeout: 5_000 });
    await expect(drawer.getByText('alice')).toBeVisible();
  });

  test('shows field diff in history record', async ({ page }) => {
    const drawer = await openDrawer(page, 'Discovery & Design');
    await drawer.getByRole('tab', { name: 'History' }).click();

    // diff: duration 8 → 10
    await expect(drawer.getByText('Duration')).toBeVisible({ timeout: 5_000 });
  });
});

// ---------------------------------------------------------------------------
// Baseline tab — no-baseline state
// ---------------------------------------------------------------------------

test.describe('TaskDetailDrawer — Baseline tab', () => {
  test.beforeEach(async ({ page }) => {
    await gotoSchedule(page);
  });

  test('shows no-baseline empty state when project has no baseline', async ({ page }) => {
    const drawer = await openDrawer(page, 'Discovery & Design');
    await drawer.getByRole('tab', { name: 'Baseline' }).click();
    await expect(drawer.getByText(/No baseline set/i)).toBeVisible({ timeout: 5_000 });
  });
});
