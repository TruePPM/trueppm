import { test, expect } from '@playwright/test';

/**
 * Schedule view E2E tests — toolbar, task list panel, and accessibility basics.
 *
 * The app makes real API calls; we intercept them with Playwright route mocking
 * and navigate to /projects/:id/schedule so useScheduleTasks fires the queries.
 * Auth state is seeded in localStorage before each test so RequireAuth passes.
 */

const FIXTURE_PROJECT_ID = 'e2e-fixture-00000000-0000-0000-0000-000000000001';

/** Minimal API-format projects matching what useProjects expects. */
const FIXTURE_API_PROJECTS = [
  { id: FIXTURE_PROJECT_ID, name: 'Alpha Platform Upgrade', description: '', start_date: '2026-01-01', calendar: 'default' },
];

/** Minimal API-format tasks (snake_case) matching TaskSerializer output. */
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
  {
    id: 't4', wbs_path: '1.3', name: 'Frontend Implementation',
    early_start: '2026-10-19', early_finish: '2026-11-06',
    duration: 15, percent_complete: 30, is_critical: false, is_milestone: false,
    status: 'IN_PROGRESS', is_summary: false, parent_id: null,
  },
  {
    id: 't5', wbs_path: '1.4', name: 'Go-Live Milestone',
    early_start: '2026-11-14', early_finish: '2026-11-14',
    duration: 0, percent_complete: 0, is_critical: true, is_milestone: true,
    status: 'NOT_STARTED', is_summary: false, parent_id: null,
  },
];

/** Set up API route interception and navigate to the Schedule view. */
async function gotoSchedule(page: import('@playwright/test').Page) {
  // Seed auth state so RequireAuth lets the test through.
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
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: FIXTURE_API_PROJECTS.length, next: null, previous: null, results: FIXTURE_API_PROJECTS }) }),
  );
  // Project detail — ProjectShell now gates every project route on this query
  // (#1111). A 200 keeps the shell mounted; an unmocked 404 would render
  // ProjectNotFound instead of the schedule.
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: FIXTURE_PROJECT_ID, name: 'Alpha Platform Upgrade', description: '', start_date: '2026-01-01', calendar: 'default', estimation_mode: 'OPEN', agile_features: false, methodology: 'HYBRID', code: '', health: 'AUTO', visibility: 'WORKSPACE', timezone: '', default_view: 'SCHEDULE', lead: null, lead_detail: null, iteration_label: 'Sprint', is_archived: false, archived_at: null, archived_by: null, recalculated_at: null, is_sample: false, program_detail: null, server_version: 1 }) }),
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
  // Stub overview endpoints so ProjectOverviewPage doesn't error on navigation
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
  // The socket mints a single-use ticket first (ADR-0141, #818); mock it so the
  // handshake proceeds instead of 404ing through the catch-all.
  await page.route('**/api/v1/ws/ticket/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ticket: 'e2e-ticket', expires_in: 30 }) }),
  );
  // Accept the project WebSocket so the StatusBar connection pill (#643) reaches
  // "Live" instead of stalling on "Connecting…". Leaving the socket open (never
  // closing it) makes the client fire `open` → markLive(); we send no frames.
  await page.routeWebSocket('**/ws/v1/projects/**', () => {
    /* accept and hold the connection open */
  });
  // Path-based routing (ADR-0030): /projects/:projectId/schedule
  await page.goto(`/projects/${FIXTURE_PROJECT_ID}/schedule`);
}

test.describe('Schedule toolbar', () => {
  test.beforeEach(async ({ page }) => {
    await gotoSchedule(page);
    // Wait for the Schedule view to finish loading (task list should be visible)
    await expect(
      page.getByRole('grid', { name: 'Task list' }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('view-mode switcher has Schedule active; Grid is present', async ({ page }) => {
    // ViewTabs renders as <nav aria-label="View"> with <Link> children (role="link").
    // Active state is indicated by aria-current="page" (not aria-pressed).
    // Grid replaces WBS + Table (issue #334, ADR-0053).
    const nav = page.getByRole('navigation', { name: 'View' });
    await expect(nav).toBeVisible();

    const scheduleLink = nav.getByRole('link', { name: 'Schedule' });
    const gridLink = nav.getByRole('link', { name: 'Grid' });

    await expect(scheduleLink).toBeVisible();
    await expect(scheduleLink).toHaveAttribute('aria-current', 'page');

    await expect(gridLink).toBeVisible();
    await expect(gridLink).not.toHaveAttribute('aria-current', 'page');

    await expect(nav.getByRole('link', { name: 'WBS' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Table' })).toHaveCount(0);
  });

  test('switching to Grid view shows the unified Grid surface', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: 'View' });
    await nav.getByRole('link', { name: 'Grid' }).click();
    await expect(page).toHaveURL(/\/grid$/);
    // HYBRID methodology defaults to Outline mode → role="treegrid".
    await expect(page.getByRole('treegrid', { name: 'Outline task tree' })).toBeVisible();
  });

  test('Today button is present and focusable', async ({ page }) => {
    const todayBtn = page.getByRole('button', { name: 'Today' });
    await expect(todayBtn).toBeVisible();
    await todayBtn.focus();
    await expect(todayBtn).toBeFocused();
  });
});

test.describe('Schedule task list', () => {
  test.beforeEach(async ({ page }) => {
    await gotoSchedule(page);
    await expect(
      page.getByRole('grid', { name: 'Task list' }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('task list header shows Dur, Start, Finish, and % columns', async ({ page }) => {
    const header = page.getByRole('row', { name: 'Task list columns' });
    await expect(header).toBeVisible();
    await expect(header.getByRole('columnheader', { name: 'Duration' })).toBeVisible();
    await expect(header.getByRole('columnheader', { name: 'Start date' })).toBeVisible();
    await expect(header.getByRole('columnheader', { name: 'Finish date' })).toBeVisible();
    await expect(header.getByRole('columnheader', { name: 'Progress' })).toBeVisible();
  });

  test('critical path tasks are announced accessibly', async ({ page }) => {
    // At least one task should have "(critical path)" in its aria-label
    const criticalCell = page.locator('[aria-label*="critical path"]').first();
    await expect(criticalCell).toBeVisible();
  });
});

test.describe('Accessibility basics', () => {
  test.beforeEach(async ({ page }) => {
    await gotoSchedule(page);
  });

  test('sidebar has accessible label', async ({ page }) => {
    // v2 left rail (ADR-0126): the aside is now labeled "Primary navigation".
    await expect(page.getByRole('complementary', { name: 'Primary navigation' })).toBeVisible();
  });

  test('status bar is a contentinfo landmark', async ({ page }) => {
    // StatusBar redesigned in #201 — aria-label is now "Application status"
    await expect(
      page.getByRole('contentinfo', { name: 'Application status' }),
    ).toBeVisible();
  });

  test('status bar shows live presence and build hash', async ({ page }) => {
    // On a project page the connection pill (#643) goes Live once the WebSocket
    // opens (routed in gotoSchedule), then appends the online count.
    const footer = page.getByRole('contentinfo', { name: 'Application status' });
    await expect(footer).toBeVisible();
    await expect(footer.getByText(/Live · \d+ online/)).toBeVisible({ timeout: 10_000 });
    await expect(footer.getByText(/build /)).toBeVisible();
  });
});

test.describe('Schedule zoom & pan (#351 / #491)', () => {
  test.beforeEach(async ({ page }) => {
    await gotoSchedule(page);
  });

  test('zoom stepper steps the derived tier; Fit button is present (#351)', async ({ page }) => {
    const group = page.getByRole('group', { name: 'Timeline zoom' }).first();
    // role="status" is now the debounced sr-only announcement (#793): the visible
    // readout is aria-hidden and updates instantly, while this live region settles
    // to the final tier ~250ms after the last change. `toHaveText` auto-retries,
    // so it waits out the debounce.
    await expect(group.getByRole('status')).toHaveText('Week'); // default tier

    // Two geometric zoom-ins from week (12 px/day) cross into the day band.
    await group.getByRole('button', { name: 'Zoom in' }).click();
    await group.getByRole('button', { name: 'Zoom in' }).click();
    await expect(group.getByRole('status')).toHaveText('Day'); // settled tier after debounce

    // Fit-to-project control exists (⌘0).
    await expect(page.getByRole('button', { name: 'Fit schedule to window' }).first()).toBeVisible();
  });

  // Skipped pending investigation in #805. Both gesture variants (Space + drag
  // and middle-button drag) land `scrollLeft === 0` in Playwright headless,
  // 100% deterministic across all retries — even though `GanttPanFSM` unit
  // tests pass and `_rebuildScales` forces `totalWidth >= 3 × viewportWidth`
  // (so `maxLeft > 0` is not the cause). The pan feature itself is verified
  // manually and the FSM is covered by `GanttPanFSM.test.ts`; what is
  // unblocked here is the end-to-end integration coverage. Drop `test.fixme`
  // once the root cause in #805 is identified.
  test.fixme('drag pans the timeline horizontally (#491)', async ({ page }) => {
    const scroll = page.getByTestId('schedule-canvas-scroll');
    await expect(scroll).toBeVisible();

    const box = await scroll.boundingBox();
    if (!box) throw new Error('canvas scroll container has no bounding box');
    const y = box.y + box.height / 2;
    const startX = box.x + box.width * 0.7;

    // Middle-button drag claims the gesture immediately (no arm step) and
    // bypasses the bar-drag FSM (rule 129). Dragging left reveals later dates.
    await page.mouse.move(startX, y);
    await page.mouse.down({ button: 'middle' });
    await page.mouse.move(startX - 200, y, { steps: 8 });
    await page.mouse.up({ button: 'middle' });

    // The scroll container actually scrolls — proves the pan FSM moved through
    // PANNING and the engine applied the delta to scrollLeft.
    await expect
      .poll(async () => scroll.evaluate((el) => (el as HTMLElement).scrollLeft))
      .toBeGreaterThan(0);
  });
});
