import { test, expect } from './fixtures/coverage';
import { setupCatchAll } from './fixtures';

/**
 * ResourceOverallocationDrawer — "Contributing tasks" name resolution (#3843).
 *
 * The drawer used to render each contributing task as a raw UUID pill with a
 * "Task names will appear once the tasks API is connected" placeholder. It now
 * batch-fetches the ids via `GET /tasks/?id__in=` (mirrors HeatmapCellDrawer's
 * own task-fetch idiom) and renders real names.
 *
 * Golden path: SCHEDULER user opens Utilization mode → clicks an overallocated
 * day cell → drawer opens → "Contributing tasks" shows resolved names, not ids.
 *
 * All API calls are intercepted via page.route() — no backend required.
 */

const PROJECT_ID = 'e2e-overalloc-drawer-00000000-0000-0000-0000-00000001';

const FIXTURE_PROJECT = {
  id: PROJECT_ID,
  name: 'Overallocation Drawer Test Project',
  description: '',
  start_date: '2026-01-01',
  calendar: 'default',
};

const RESOURCE_ID = 'res-nina';
const TASK_A_ID = 'task-a-11111111-1111-1111-1111-111111111111';
const TASK_B_ID = 'task-b-22222222-2222-2222-2222-222222222222';

const FIXTURE_TASKS = [
  {
    id: TASK_A_ID,
    wbs_path: '1',
    name: 'Wire the avionics loom',
    status: 'IN_PROGRESS',
    early_start: '2026-01-05',
    early_finish: '2026-01-20',
  },
  {
    id: TASK_B_ID,
    wbs_path: '2',
    name: 'Calibrate the sensor rig',
    status: 'NOT_STARTED',
    early_start: '2026-01-05',
    early_finish: '2026-01-20',
  },
];

/** Local calendar date (Y-M-D) matching resourceUtils.todayISO()'s local-date logic. */
function todayIso(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const TODAY = todayIso();

const FIXTURE_UTILIZATION = {
  project_id: PROJECT_ID,
  window: { start: '2026-01-01', end: '2026-12-31' },
  resources: [
    {
      resource_id: RESOURCE_ID,
      resource_name: 'Nina Alvarez',
      max_units: '1.00',
      hours_per_day: 8,
      calendar_id: null,
      calendar_differs_from_project: false,
      overallocated: true,
      days: {
        [TODAY]: {
          hours: 10,
          tasks: [TASK_A_ID, TASK_B_ID],
          load_pct: 125,
          load_band: 'critical',
          overallocated: true,
        },
      },
    },
  ],
  unassigned_task_count: 0,
};

const MEMBER_SCHEDULER = [{ id: 'mem-sched', role: 200 }];

type Page = import('@playwright/test').Page;

async function setup(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
    // Land directly in Utilization mode — this drawer only opens from that grid.
    localStorage.setItem('trueppm.resources.viewMode', 'utilization');
  });

  const pj = (results: unknown[]) =>
    JSON.stringify({ count: results.length, next: null, previous: null, results });

  // Catch-all FIRST so an unmocked endpoint returns a typed 404 instead of
  // falling through and 401ing, which trips the token-refresh session
  // teardown and races the page render (#2366). Routes below win.
  await setupCatchAll(page);

  await page.route('**/api/v1/projects/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([FIXTURE_PROJECT]) }),
  );
  // ProjectShell gates every project route on the detail query (#1111): a 404
  // renders ProjectNotFound in place of the page under test.
  await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(FIXTURE_PROJECT),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/overview/`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        schedule_health: 'on_track',
        spi: null,
        tasks_late_count: 0,
        critical_task_count: 0,
        total_tasks: 2,
        complete_tasks: 0,
        next_milestone: null,
        team_utilization_pct: 100,
        owner_name: null,
        start_date: '2026-01-01',
      }),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/attention/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/my-tasks/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tasks: [] }) }),
  );
  await page.route('**/api/v1/projects/*/presence/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  await page.route('**/api/v1/projects/*/status-summary/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        task_count: 2,
        health_band: 'on_track',
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
  // The batch task-name lookup this issue adds (#3843, ?id__in=). The mock
  // ignores query params (like every other tasks/** stub in this suite) and
  // just returns the fixture set — the real filter is covered by the API's
  // own pytest, not this e2e layer.
  await page.route('**/api/v1/tasks/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_TASKS) }),
  );
  await page.route('**/api/v1/dependencies/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }),
  );
  await page.route('**/api/v1/projects/*/risks/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }),
  );
  await page.route('**/api/v1/projects/*/board-config/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ columns: [] }) }),
  );
  await page.route('**/api/v1/monte-carlo/**', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ runs: 0, p50: null, p80: null, p95: null, buckets: [] }),
    }),
  );
  await page.route('**/api/v1/projects/*/resources/heatmap/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ weeks: [], resources: [] }) }),
  );
  await page.route('**/api/v1/projects/*/resources/summary/**', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        avg_utilization_pct: 0,
        over_allocated_count: 0,
        over_allocated_weeks: '',
        under_utilized_count: 0,
        under_utilized_names: [],
        headcount: 0,
        contractor_count: 0,
      }),
    }),
  );

  // --- RBAC ---
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/**`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MEMBER_SCHEDULER) }),
  );

  // --- Utilization grid (the mode under test) ---
  await page.route(`**/api/v1/projects/${PROJECT_ID}/utilization/**`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(FIXTURE_UTILIZATION),
    }),
  );

  // Unused in utilization mode but may be fetched on mount.
  await page.route(`**/api/v1/projects/${PROJECT_ID}/resource-allocation/**`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        project_id: PROJECT_ID,
        window_start: '2026-01-01',
        window_end: '2026-12-31',
        resources: [],
        resource_count: 0,
        truncated: false,
      }),
    }),
  );
}

test.describe('Contributing tasks — name resolution', () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/resources/allocation`);
    await expect(page.getByText('Nina Alvarez')).toBeVisible({ timeout: 10_000 });
  });

  test('opening the overallocated day cell shows resolved task names, not raw UUIDs', async ({
    page,
  }) => {
    await page
      .getByRole('button', { name: new RegExp(`load on ${TODAY} — overallocated`, 'i') })
      .click();

    const drawer = page.getByRole('dialog', { name: /Overallocation — Nina Alvarez/i });
    await expect(drawer).toBeVisible();

    await expect(drawer.getByText('Wire the avionics loom')).toBeVisible();
    await expect(drawer.getByText('Calibrate the sensor rig')).toBeVisible();

    // A UUID-shaped id must not be on screen once names have resolved.
    await expect(drawer.getByText(TASK_A_ID)).not.toBeVisible();
    await expect(drawer.getByText(TASK_B_ID)).not.toBeVisible();

    // The stale "not connected" deferral copy must be gone.
    await expect(drawer.getByText(/tasks API is connected/i)).not.toBeVisible();
  });

  test('a task id that fails to resolve degrades to its raw id with an explanatory note', async ({
    page,
  }) => {
    // Task API returns only one of the two contributing ids — the other has
    // since been deleted. The drawer must still render, not go blank.
    await page.route('**/api/v1/tasks/**', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: 1, next: null, previous: null, results: [FIXTURE_TASKS[0]] }),
      }),
    );

    await page
      .getByRole('button', { name: new RegExp(`load on ${TODAY} — overallocated`, 'i') })
      .click();

    const drawer = page.getByRole('dialog', { name: /Overallocation — Nina Alvarez/i });
    await expect(drawer.getByText('Wire the avionics loom')).toBeVisible();
    await expect(drawer.getByText(TASK_B_ID)).toBeVisible();
    await expect(drawer.getByText(/may have been deleted/i)).toBeVisible();
  });

  test('a failed task fetch degrades every contributing task to its raw id, with a retry', async ({
    page,
  }) => {
    await page.route('**/api/v1/tasks/**', (r) =>
      r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: 'boom' }) }),
    );

    await page
      .getByRole('button', { name: new RegExp(`load on ${TODAY} — overallocated`, 'i') })
      .click();

    const drawer = page.getByRole('dialog', { name: /Overallocation — Nina Alvarez/i });
    await expect(drawer.getByText(TASK_A_ID)).toBeVisible();
    await expect(drawer.getByText(TASK_B_ID)).toBeVisible();
    await expect(drawer.getByText(/couldn.t load task names/i)).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Retry' })).toBeVisible();
  });
});
