/**
 * Task detail drawer — non-modal inspector + click-to-swap (issue #1978).
 *
 * The desktop task detail drawer (src/features/schedule/TaskDetailDrawer.tsx) is
 * now a TRUE non-modal inspector: aria-modal="false", no focus trap, and the
 * host surface behind it stays live so clicking another task SWAPS the drawer to
 * it. A clean swap is instant; a swap while the name/notes draft is DIRTY raises
 * a 3-verb guard (Keep editing · Discard & open · Save & open). Mobile stays a
 * modal bottom sheet (aria-modal="true").
 *
 * Host: the Sprints backlog (SprintsView). It is the simplest deterministic host
 * for this drawer — a backlog ROW is a plain DOM "Open <name>" button that opens
 * the shared TaskDetailDrawer directly, and clicking a second row swaps it
 * directly (no canvas hit-testing like the Schedule Gantt, no drag layer like the
 * Board). The mock/auth/fixture setup mirrors e2e/wave10-sprints-backlog.spec.ts.
 */
import { test, expect, type Page } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

const PROJECT_ID = 'e2e-drawer-swap-00000000-0000-0000-0000-000000000078';
const BASE_URL = `/projects/${PROJECT_ID}/sprints`;

const FIXTURE_PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Drawer Swap Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
    methodology: 'AGILE',
  },
];

const PROJECT_DETAIL = {
  id: PROJECT_ID,
  server_version: 1,
  name: 'Drawer Swap Project',
  description: '',
  start_date: '2026-04-01',
  calendar: null,
  estimation_mode: 'open',
  agile_features: true,
  methodology: 'AGILE',
};

const ACTIVE_SPRINT = {
  id: 'sp-active',
  server_version: 1,
  short_id: 'C0FF',
  short_id_display: 'SP-C0FF',
  name: 'Telemetry & FAT prep',
  goal: 'Close out telemetry firmware sweep.',
  start_date: '2026-04-01',
  finish_date: '2026-04-14',
  state: 'ACTIVE',
  target_milestone: null,
  target_milestone_detail: null,
  committed_points: 40,
  committed_task_count: 18,
  completed_points: 14,
  completed_task_count: 6,
  completion_ratio_points: 0.35,
  completion_ratio_tasks: 0.33,
  activated_at: '2026-04-01T00:00:00Z',
  closed_at: null,
  created_at: '2026-04-01T00:00:00Z',
  updated_at: '2026-04-04T12:00:00Z',
};

// Two IN_PROGRESS backlog rows so both render in the same status group and are
// visible without expanding anything — task A is opened first, task B is the
// swap target.
const BACKLOG_TASKS = [
  {
    id: 'task-a',
    short_id: 'A1',
    name: 'Calibrate sensors',
    wbs_path: '1.1',
    status: 'IN_PROGRESS',
    story_points: 5,
    is_critical: false,
    assignments: [],
  },
  {
    id: 'task-b',
    short_id: 'A2',
    name: 'Wire telemetry channel',
    wbs_path: '1.2',
    status: 'IN_PROGRESS',
    story_points: 8,
    is_critical: false,
    assignments: [],
  },
];

// Full-Task project list (GET /tasks/?project=) feeding useScheduleTasks, which
// SprintsView's taskIndex resolves a clicked row against to open the drawer.
// can_edit:true guarantees the name input is editable regardless of role
// resolution, so the dirty-swap scenarios can make the draft dirty.
function fullTaskShape(t: { id: string; name: string; wbs_path: string; status: string }) {
  return {
    id: t.id,
    name: t.name,
    wbs_path: t.wbs_path,
    status: t.status,
    parent_id: null,
    notes: '',
    early_start: '2026-04-05',
    early_finish: '2026-04-10',
    planned_start: '2026-04-05',
    duration: 5,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    assignees: [],
    total_float: null,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
    can_edit: true,
  };
}
const FULL_TASKS = BACKLOG_TASKS.map(fullTaskShape);

async function setup(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });

  // Hermetic 401-guard net FIRST (Playwright matches routes LIFO, so every
  // specific route below wins). Any shell endpoint this spec does not mock —
  // notifications, timer, ws/ticket, monte-carlo, programs, … — would otherwise
  // fall through Vite's proxy to the live shared backend on :8000, take a real
  // 401 for the fixture token, and racily trip the SessionExpired modal, which
  // then intercepts every click. setupCatchAll returns 404 (≠ 401), keeping the
  // page hermetic.
  await setupCatchAll(page);

  await page.route('**/api/v1/projects/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 1, next: null, previous: null, results: FIXTURE_PROJECTS }),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(PROJECT_DETAIL),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/sprints/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 1, next: null, previous: null, results: [ACTIVE_SPRINT] }),
    }),
  );
  await page.route(`**/api/v1/sprints/${ACTIVE_SPRINT.id}/burndown/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ sprint: ACTIVE_SPRINT, snapshots: [] }),
    }),
  );
  await page.route(`**/api/v1/sprints/${ACTIVE_SPRINT.id}/capacity/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        members: [],
        totals: {
          committed_hours: 0,
          available_hours: 0,
          ratio: 0,
          buffer_hours: 0,
          label: 'on_track',
          pto_days: 0,
        },
        working_days: 0,
        hours_per_day: 8,
      }),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/velocity/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sprints: [],
        rolling_avg_points: null,
        rolling_stdev_points: null,
        forecast_range_low: null,
        forecast_range_high: null,
        rolling_avg_tasks: null,
        rolling_stdev_tasks: null,
      }),
    }),
  );
  // Catch-all FIRST (Playwright last-registered-wins): specific /tasks/ matches
  // below take precedence.
  await page.route(/\/api\/v1\/tasks\//, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
  // Full project task list (project=, no sprint=) — the drawer's task source.
  await page.route(/\/api\/v1\/tasks\/\?(?!.*sprint=).*project=/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        count: FULL_TASKS.length,
        next: null,
        previous: null,
        results: FULL_TASKS,
      }),
    }),
  );
  // Sprint-filtered backlog rows.
  await page.route(/\/api\/v1\/tasks\/.*sprint=sp-active/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        count: BACKLOG_TASKS.length,
        next: null,
        previous: null,
        results: BACKLOG_TASKS,
      }),
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
  await page.route('**/api/v1/edition/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ edition: 'community' }),
    }),
  );
  await page.route('**/api/v1/auth/me/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'e2e-user',
        username: 'e2e',
        display_name: 'E2E',
        initials: 'E',
        email: 'e2e@example.com',
      }),
    }),
  );
  // Members endpoint — regex (not glob) so it matches the `?self=true` query the
  // useCurrentUserRole hook appends; a trailing-slash glob would miss it and let
  // the request fall through. Admin role for good measure (can_edit on the task
  // fixture is the actual editability guarantee).
  await page.route(/\/api\/v1\/projects\/[^/]*\/members\//, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'mem-1', role: 300, role_label: 'Admin' }]),
    }),
  );
  await page.route(/\/api\/v1\/sprints\/.*\/retro\//, (route) =>
    route.fulfill({ status: 404, contentType: 'application/json', body: '{"detail":"None"}' }),
  );
  await page.route('**/api/v1/me/active-sprints/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
}

/** Click a backlog row's "Open <name>" button and wait for the drawer to render
 *  that task (gated on the editable Task name input holding the task's value —
 *  a signal that only appears after the drawer's reads resolve). */
async function openTask(page: Page, name: string) {
  const backlog = page.getByRole('region', { name: /Sprint Backlog/i });
  await backlog.getByRole('button', { name: new RegExp(`Open ${name}`, 'i') }).click();
  const drawer = page.getByRole('dialog', { name: new RegExp(name, 'i') });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByLabel('Task name')).toHaveValue(name);
  return drawer;
}

test.describe('#1978 — task drawer non-modal inspector + click-to-swap', () => {
  test('desktop drawer is non-modal (aria-modal="false")', async ({ page }) => {
    await setup(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(BASE_URL);

    const drawer = await openTask(page, 'Calibrate sensors');
    // The task drawer (matched by its WBS-prefixed accessible name) is a true
    // non-modal inspector — background stays live, no focus trap.
    await expect(drawer).toHaveAttribute('aria-modal', 'false');
  });

  test('clicking another task swaps the drawer instantly, no guard (clean)', async ({ page }) => {
    await setup(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(BASE_URL);

    await openTask(page, 'Calibrate sensors');

    // Click task B while A is open and clean — background row stays clickable
    // (non-modal), so the drawer swaps directly.
    await page
      .getByRole('region', { name: /Sprint Backlog/i })
      .getByRole('button', { name: /Open Wire telemetry channel/i })
      .click();

    // No unsaved-changes guard on a clean swap.
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    // Drawer now shows B and did not close; A is no longer the drawer subject.
    const drawerB = page.getByRole('dialog', { name: /Wire telemetry channel/i });
    await expect(drawerB).toBeVisible();
    await expect(drawerB.getByLabel('Task name')).toHaveValue('Wire telemetry channel');
    await expect(page.getByRole('dialog', { name: /Calibrate sensors/i })).toHaveCount(0);
  });

  test('swap while dirty raises the 3-verb guard; Keep editing stays on A', async ({ page }) => {
    await setup(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(BASE_URL);

    const drawerA = await openTask(page, 'Calibrate sensors');

    // Dirty the draft by editing the task name.
    await drawerA.getByLabel('Task name').fill('Calibrate sensors EDITED');

    // Attempt to swap to B.
    await page
      .getByRole('region', { name: /Sprint Backlog/i })
      .getByRole('button', { name: /Open Wire telemetry channel/i })
      .click();

    // The 3-verb swap guard appears with all three verbs.
    const guard = page.getByRole('alertdialog');
    await expect(guard).toBeVisible();
    await expect(guard.getByRole('button', { name: 'Keep editing' })).toBeVisible();
    await expect(guard.getByRole('button', { name: 'Discard & open' })).toBeVisible();
    await expect(guard.getByRole('button', { name: 'Save & open' })).toBeVisible();

    // Keep editing → guard dismisses, drawer still shows A with the edit intact.
    await guard.getByRole('button', { name: 'Keep editing' }).click();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    const stillA = page.getByRole('dialog', { name: /Calibrate sensors/i });
    await expect(stillA).toBeVisible();
    await expect(stillA.getByLabel('Task name')).toHaveValue('Calibrate sensors EDITED');
    // B was never opened.
    await expect(page.getByRole('dialog', { name: /Wire telemetry channel/i })).toHaveCount(0);
  });

  test('swap while dirty — Discard & open drops the edit and opens B', async ({ page }) => {
    await setup(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(BASE_URL);

    const drawerA = await openTask(page, 'Calibrate sensors');
    await drawerA.getByLabel('Task name').fill('Calibrate sensors EDITED');

    await page
      .getByRole('region', { name: /Sprint Backlog/i })
      .getByRole('button', { name: /Open Wire telemetry channel/i })
      .click();

    const guard = page.getByRole('alertdialog');
    await expect(guard).toBeVisible();
    await guard.getByRole('button', { name: 'Discard & open' }).click();

    // Guard closes; drawer now shows B seeded from B's server value (not A's edit).
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    const drawerB = page.getByRole('dialog', { name: /Wire telemetry channel/i });
    await expect(drawerB).toBeVisible();
    await expect(drawerB.getByLabel('Task name')).toHaveValue('Wire telemetry channel');
    await expect(page.getByRole('dialog', { name: /Calibrate sensors/i })).toHaveCount(0);
  });

  test('mobile stays modal (aria-modal="true")', async ({ page }) => {
    // The wave10 backlog spec drives this same host at 375px without hitting the
    // auth-state login flake the memory notes warn about (the addInitScript token
    // above is applied before navigation), so scenario 4 is safe on this host.
    await setup(page);
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto(BASE_URL);

    const drawer = await openTask(page, 'Calibrate sensors');
    await expect(drawer).toHaveAttribute('aria-modal', 'true');
  });
});
