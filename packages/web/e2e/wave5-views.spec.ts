import { test, expect } from '@playwright/test';

/**
 * E2E tests for wave 5 views — Calendar (#206) plus the unified Grid view
 * (issue #334, ADR-0053) which replaces the former Table (#207) and WBS
 * (#209) entries.
 * - Calendar: legend visible; milestone diamond marker renders; month nav works
 * - Grid Flat mode (former Table): toolbar search input; status pills; mode toggle
 * - Grid Outline mode (former WBS): Predecessors column header; milestone ◆ glyph
 */

const FIXTURE_PROJECT_ID = 'e2e-wave5-00000000-0000-0000-0000-000000000005';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}`;

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Wave 5 Test Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
    estimation_mode: 'open',
  },
];

const FIXTURE_TASKS = [
  {
    id: 'summary1', wbs_path: '1', name: 'Phase 1',
    early_start: '2026-04-07', early_finish: '2026-04-30',
    planned_start: null, duration: 17, percent_complete: 30,
    is_critical: false, is_milestone: false, is_summary: true,
    parent_id: null, status: 'IN_PROGRESS',
    actual_start: null, actual_finish: null, schedule_variance_days: null,
    baseline_start: null, baseline_finish: null,
    optimistic_duration: null, most_likely_duration: null, pessimistic_duration: null,
    estimate_status: null, total_float: null, assignments: [],
  },
  {
    id: 'task1', wbs_path: '1.1', name: 'Design Sprint',
    early_start: '2026-04-07', early_finish: '2026-04-14',
    // Completed task → never critical (#1863).
    planned_start: null, duration: 7, percent_complete: 100,
    is_critical: false, is_milestone: false, is_summary: false,
    parent_id: 'summary1', status: 'COMPLETE',
    actual_start: null, actual_finish: null, schedule_variance_days: null,
    baseline_start: null, baseline_finish: null,
    optimistic_duration: null, most_likely_duration: null, pessimistic_duration: null,
    estimate_status: null, total_float: 0,
    assignments: [{ resource_id: 'r1', resource_name: 'Alice Kim', units: 1.0 }],
  },
  {
    id: 'task2', wbs_path: '1.2', name: 'Backend Build',
    early_start: '2026-04-14', early_finish: '2026-04-28',
    planned_start: null, duration: 10, percent_complete: 0,
    is_critical: false, is_milestone: false, is_summary: false,
    parent_id: 'summary1', status: 'NOT_STARTED',
    actual_start: null, actual_finish: null, schedule_variance_days: null,
    baseline_start: null, baseline_finish: null,
    optimistic_duration: null, most_likely_duration: null, pessimistic_duration: null,
    estimate_status: null, total_float: 5, assignments: [],
  },
  {
    id: 'ms1', wbs_path: '1.3', name: 'Phase 1 Gate',
    early_start: '2026-04-28', early_finish: '2026-04-28',
    planned_start: null, duration: 0, percent_complete: 0,
    is_critical: false, is_milestone: true, is_summary: false,
    parent_id: 'summary1', status: 'NOT_STARTED',
    actual_start: null, actual_finish: null, schedule_variance_days: null,
    baseline_start: null, baseline_finish: null,
    optimistic_duration: null, most_likely_duration: null, pessimistic_duration: null,
    estimate_status: null, total_float: null, assignments: [],
  },
];

const FIXTURE_DEPS = [
  { id: 'dep1', predecessor: 'task1', successor: 'task2', dep_type: 'FS', lag: 0 },
];

async function setup(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });

  const pj = (results: unknown[]) =>
    JSON.stringify({ count: results.length, next: null, previous: null, results });

  await page.route('**/api/v1/projects/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_PROJECTS) }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/overview/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ schedule_health: 'on_track', spi: null, tasks_late_count: 0, critical_task_count: 1, total_tasks: 4, complete_tasks: 1, next_milestone: null, team_utilization_pct: null, owner_name: null, start_date: '2026-04-01' }) }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/attention/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/my-tasks/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tasks: [] }) }),
  );
  await page.route('**/api/v1/projects/*/presence/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  await page.route('**/api/v1/projects/*/status-summary/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ task_count: 4, critical_path_count: 1, monte_carlo_p80: null, at_risk_count: 0, critical_count: 1, at_risk_tasks: [], critical_tasks: [], last_saved: null, recalculated_at: null }) }),
  );
  await page.route('**/api/v1/tasks/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_TASKS) }),
  );
  await page.route('**/api/v1/dependencies/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_DEPS) }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/resource-allocation/**`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ project_id: FIXTURE_PROJECT_ID, window_start: '2026-01-01', window_end: '2026-06-01', resources: [] }) }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/risks/**`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/board-config/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ columns: [{ status: 'BACKLOG', label: 'Backlog', visible: true }, { status: 'NOT_STARTED', label: 'To Do', visible: true }, { status: 'IN_PROGRESS', label: 'In Progress', visible: true }, { status: 'REVIEW', label: 'Review', visible: true }, { status: 'COMPLETE', label: 'Done', visible: true }] }) }),
  );
  await page.route('**/api/v1/monte-carlo/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ runs: 0, p50: null, p80: null, p95: null, buckets: [] }) }),
  );
}

// ---------------------------------------------------------------------------
// Grid view — Flat mode (replaces #207 Table; issue #334, ADR-0053)
// ---------------------------------------------------------------------------

test.describe('Grid view — Flat mode (#334)', () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
    // /list redirects to /grid; switch to Flat via the segmented control to
    // exercise the former Table-view behaviour.
    await page.goto(`${BASE_URL}/grid`);
    await page.getByRole('button', { name: 'Flat list' }).click();
    await expect(page.getByRole('grid', { name: 'Task list' })).toBeVisible({ timeout: 10_000 });
  });

  test('renders search input in the toolbar', async ({ page }) => {
    await expect(page.getByRole('searchbox', { name: 'Search tasks' })).toBeVisible();
  });

  test('renders status pills for Done and Not started', async ({ page }) => {
    // Fixture: 1 COMPLETE task (Design Sprint) → 1 "Done" pill;
    //         2 NOT_STARTED tasks (Backend Build, Phase 1 Gate) → 2 "Not started" pills.
    await expect(page.getByText('Done')).toHaveCount(1);
    await expect(page.getByText('Not started')).toHaveCount(2);
  });

  test('switching to Grouped mode reveals the group-by selector', async ({ page }) => {
    await page.getByRole('button', { name: 'Grouped' }).click();
    await expect(page.getByLabel('Group by dimension')).toBeVisible();
  });

  test('search filters rows by task name', async ({ page }) => {
    const input = page.getByRole('searchbox', { name: 'Search tasks' });
    await input.fill('Design');
    await expect(page.getByText('Design Sprint')).toBeVisible();
    await expect(page.getByText('Backend Build')).toBeHidden();
  });
});

// ---------------------------------------------------------------------------
// Grid view — Outline mode (replaces #209 WBS; issue #334, ADR-0053)
// ---------------------------------------------------------------------------

test.describe('Grid view — Outline mode (#334)', () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
    // HYBRID methodology defaults to Outline mode; the legacy /wbs URL
    // redirects to /grid, so navigate directly to /grid.
    await page.goto(`${BASE_URL}/grid`);
    await expect(page.getByRole('treegrid', { name: 'Outline task tree' }))
      .toBeVisible({ timeout: 10_000 });
  });

  test('renders Predecessors column header', async ({ page }) => {
    await expect(page.getByText('Predecessors', { exact: true })).toBeVisible();
  });

  test('renders Start and Finish column headers', async ({ page }) => {
    await expect(page.getByText('Start', { exact: true })).toBeVisible();
    await expect(page.getByText('Finish', { exact: true })).toBeVisible();
  });

  test('milestone row shows diamond glyph ◆', async ({ page }) => {
    await expect(page.getByText('◆')).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Calendar view (#206)
// ---------------------------------------------------------------------------

test.describe('Calendar view (#206)', () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
    // Pin the anchor to the fixture's month — the calendar defaults to today,
    // so without this the Phase 1 Gate milestone (2026-04-28) scrolls out of
    // the visible grid once the wall-clock month is no longer adjacent to April.
    await page.goto(`${BASE_URL}/calendar?calAnchor=2026-04-15`);
    await expect(page.getByLabel('Calendar legend')).toBeVisible({ timeout: 10_000 });
  });

  test('renders legend with all four entries', async ({ page }) => {
    const legend = page.getByLabel('Calendar legend');
    await expect(legend.getByText('Critical path')).toBeVisible();
    await expect(legend.getByText('At risk')).toBeVisible();
    await expect(legend.getByText('On track')).toBeVisible();
    await expect(legend.getByText('Milestone')).toBeVisible();
  });

  test('milestone diamond button is visible for Phase 1 Gate', async ({ page }) => {
    // Pin the calendar to the milestone's month. useCalendarFilter defaults the
    // anchor to "today", so on any run date outside April 2026 the fixture's
    // 2026-04-28 milestone renders off-screen and the diamond never mounts
    // (date-rot — passed only while "today" was still in April).
    await page.goto(`${BASE_URL}/calendar?calAnchor=2026-04-15`);
    await expect(page.getByRole('button', { name: /Milestone: Phase 1 Gate/i })).toBeVisible();
  });

  test('next-month navigation changes the month label', async ({ page }) => {
    // Use name filter to avoid matching sidebar h2 section headers
    const label = page.getByRole('heading', { level: 2, name: /2026/i });
    const before = await label.textContent();
    await page.getByRole('button', { name: /Next month/i }).click();
    // Use assertion with retry to wait for React re-render from setSearchParams
    await expect(label).not.toHaveText(before ?? '');
  });
});
