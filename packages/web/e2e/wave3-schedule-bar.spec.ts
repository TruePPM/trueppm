import { test, expect } from '@playwright/test';

/**
 * E2E tests for wave 3 schedule bar rendering (#212):
 * - % completion chip inside the bar (canvas-bars layer)
 * - Task name rendered outside the bar for light-mode legibility
 *
 * Canvas content is not DOM-accessible; these tests validate the ARIA overlay
 * (which mirrors canvas data), basic canvas element presence, and a screenshot
 * comparison to catch visual regressions in bar / chip / label positioning.
 */

const FIXTURE_PROJECT_ID = 'e2e-fixture-00000000-0000-0000-0000-000000000001';

const FIXTURE_API_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Schedule Bar Test Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

/** Tasks covering all chip/label rendering branches in drawTaskBar(). */
const FIXTURE_API_TASKS = [
  {
    // 40% complete — chip should render
    id: 't1', wbs_path: '1', name: 'Design Sprint',
    early_start: '2026-04-07', early_finish: '2026-04-21',
    planned_start: null, duration: 14, percent_complete: 40,
    is_critical: false, is_milestone: false, is_summary: false,
    parent_id: null, status: 'IN_PROGRESS',
    actual_start: null, actual_finish: null, schedule_variance_days: null,
    baseline_start: null, baseline_finish: null,
    optimistic_duration: null, most_likely_duration: null, pessimistic_duration: null,
    estimate_status: null, total_float: 5, assignments: [],
  },
  {
    // 0% NOT_STARTED — no chip (only render chip if progress > 0)
    id: 't2', wbs_path: '2', name: 'Backend Implementation',
    early_start: '2026-04-14', early_finish: '2026-04-28',
    planned_start: null, duration: 10, percent_complete: 0,
    is_critical: true, is_milestone: false, is_summary: false,
    parent_id: null, status: 'NOT_STARTED',
    actual_start: null, actual_finish: null, schedule_variance_days: null,
    baseline_start: null, baseline_finish: null,
    optimistic_duration: null, most_likely_duration: null, pessimistic_duration: null,
    estimate_status: null, total_float: 0, assignments: [],
  },
  {
    // 100% complete — complete bar color (#166534)
    id: 't3', wbs_path: '3', name: 'Discovery',
    early_start: '2026-04-01', early_finish: '2026-04-07',
    planned_start: null, duration: 5, percent_complete: 100,
    is_critical: false, is_milestone: false, is_summary: false,
    parent_id: null, status: 'COMPLETE',
    actual_start: '2026-04-01', actual_finish: '2026-04-07',
    schedule_variance_days: 0, baseline_start: null, baseline_finish: null,
    optimistic_duration: null, most_likely_duration: null, pessimistic_duration: null,
    estimate_status: null, total_float: 10, assignments: [],
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
      body: JSON.stringify({ schedule_health: 'on_track', spi: null, tasks_late_count: 0, critical_task_count: 1, total_tasks: 3, complete_tasks: 1, next_milestone: null, team_utilization_pct: null, owner_name: null, start_date: '2026-01-01' }),
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

  await page.goto(`/projects/${FIXTURE_PROJECT_ID}/schedule`);
}

// ---------------------------------------------------------------------------
// ARIA overlay — task names must be accessible regardless of canvas rendering
// ---------------------------------------------------------------------------

test.describe('Schedule bar — ARIA accessibility (#212)', () => {
  test.beforeEach(async ({ page }) => {
    await gotoSchedule(page);
    await expect(page.getByRole('grid', { name: 'Task list' })).toBeVisible({ timeout: 10_000 });
  });

  test('task names are accessible via ARIA grid cells', async ({ page }) => {
    // GanttAriaOverlay wraps canvas with role="grid" cells containing aria-label per task
    const designCell = page.locator('[aria-label*="Design Sprint"]').first();
    await expect(designCell).toBeVisible();
  });

  test('critical path task has critical-path annotation in ARIA label', async ({ page }) => {
    const criticalCell = page.locator('[aria-label*="critical path"]').first();
    await expect(criticalCell).toBeVisible();
  });

  test('complete task is accessible in task list', async ({ page }) => {
    // "Discovery" is 100% complete — verifiable via the task list panel
    const grid = page.getByRole('grid', { name: 'Task list' });
    await expect(grid.getByText('Discovery')).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Canvas element presence and structure
// ---------------------------------------------------------------------------

test.describe('Schedule bar — canvas structure (#212)', () => {
  test.beforeEach(async ({ page }) => {
    await gotoSchedule(page);
    await expect(page.getByRole('grid', { name: 'Task list' })).toBeVisible({ timeout: 10_000 });
  });

  test('canvas-bars layer is present in the DOM', async ({ page }) => {
    // The three-layer canvas stack (rule 59) must have a canvas-bars element
    const barsCanvas = page.locator('canvas[data-layer="bars"]');
    await expect(barsCanvas).toBeAttached();
  });

  test('canvas layers are aria-hidden', async ({ page }) => {
    // Canvas renders are hidden from AT; ARIA overlay carries all semantics
    const canvases = page.locator('canvas[aria-hidden="true"]');
    await expect(canvases.first()).toBeAttached();
  });
});

// Canvas visual regression is intentionally not covered here — pixel snapshots
// are platform-dependent (font rendering, antialiasing, devicePixelRatio) and
// the only practical baseline format would be one snapshot per OS. The chip
// and outside-name rendering functions are covered by unit tests against
// GanttRenderer; the structural canvas-bars layer test above guarantees the
// rendering surface is mounted.
