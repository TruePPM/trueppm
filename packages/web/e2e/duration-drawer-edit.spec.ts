/**
 * Task detail drawer — editable Duration cell (#2106, ADR-0515).
 *
 * The schedule "vitals" strip (Start · Finish · Duration · Float) used to be a
 * fully read-only grid; the only way to change a task's duration was to drag the
 * Gantt bar's resize handle. The Duration cell is now an inline click-to-edit
 * field that commits IMMEDIATELY via PATCH /tasks/:id/ (mirroring build mode) and
 * lets the strip refresh to the recomputed dates. Editing is gated on can_edit,
 * suppressed for milestones, and rejects invalid input inline (web-rule 225); a
 * server span-cap 400 (#1862) surfaces inline.
 *
 * Host: the Sprints backlog (SprintsView) — the simplest deterministic host for
 * this drawer (a backlog ROW is a plain "Open <name>" button that opens the
 * shared TaskDetailDrawer directly, no canvas hit-testing / drag layer). Mock
 * scaffold mirrors e2e/task-drawer-estimate-batch.spec.ts.
 */
import { test, expect, type Page } from '@playwright/test';
import { setupCatchAll } from './fixtures/api-mocks';

const PROJECT_ID = 'e2e-dur-edit-00000000-0000-0000-0000-000000002106';
const TASK_ID = 'dur-task-a';
const BASE_URL = `/projects/${PROJECT_ID}/sprints`;

const FIXTURE_PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Duration Edit Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
    methodology: 'AGILE',
  },
];

const PROJECT_DETAIL = {
  id: PROJECT_ID,
  server_version: 1,
  name: 'Duration Edit Project',
  description: '',
  start_date: '2026-04-01',
  calendar: null,
  estimation_mode: 'open',
  agile_features: true,
  methodology: 'AGILE',
  // Default duration-change policy — 'keep' means a duration edit never raises
  // the ADR-0151 recalc-% prompt, keeping these assertions deterministic.
  effective_task_duration_change_percent_policy: 'keep',
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

const BACKLOG_TASKS = [
  {
    id: TASK_ID,
    short_id: 'A1',
    name: 'Calibrate sensors',
    wbs_path: '1.1',
    status: 'IN_PROGRESS',
    story_points: 5,
    is_critical: false,
    assignments: [],
  },
];

function fullTasks(duration: number) {
  return [
    {
      id: TASK_ID,
      name: 'Calibrate sensors',
      wbs_path: '1.1',
      status: 'IN_PROGRESS',
      parent_id: null,
      notes: '',
      early_start: '2026-04-05',
      early_finish: '2026-04-10',
      planned_start: '2026-04-05',
      duration,
      percent_complete: 0,
      is_critical: false,
      is_milestone: false,
      is_summary: false,
      assignees: [],
      total_float: 4,
      predecessor_count: 0,
      is_blocked: false,
      linked_risks_count: 0,
      linked_risks_max_severity: null,
      can_edit: true,
    },
  ];
}

/**
 * Install the shared mock scaffold. `state.duration` is the single source of
 * truth for the task's duration across the GET task lists AND the PATCH
 * response, so a committed edit is reflected by the post-mutation refetch
 * (['tasks'] invalidation) rather than snapping back to the seed value.
 * `state.failMessage` forces the next PATCH to 400 with a `{duration:[…]}` body.
 */
async function setup(page: Page) {
  const state = { duration: 5, failMessage: null as string | null };
  const patches: Array<Record<string, unknown>> = [];

  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });

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

  // PATCH /tasks/:id/ — captured; success updates the shared duration, a forced
  // failMessage returns the server span-cap 400 shape (#1862). Registered before
  // the GET task-list routes but after setupCatchAll; the URL regex excludes
  // query strings so the GET lists never match here.
  await page.route(/\/api\/v1\/tasks\/[^/?]+\/$/, async (route) => {
    const req = route.request();
    if (req.method() !== 'PATCH') return route.fallback();
    const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
    patches.push(body);
    if (state.failMessage) {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ duration: [state.failMessage] }),
      });
      return;
    }
    if (typeof body.duration === 'number') state.duration = body.duration;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: TASK_ID,
        name: 'Calibrate sensors',
        project: PROJECT_ID,
        wbs_path: '1.1',
        duration: state.duration,
        status: 'IN_PROGRESS',
        percent_complete: 0,
      }),
    });
  });

  // Catch-all /tasks/ (empty list), then the specific project task list — last
  // registered wins in Playwright, so the specific matches take precedence.
  await page.route(/\/api\/v1\/tasks\//, (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    });
  });
  await page.route(/\/api\/v1\/tasks\/\?(?!.*sprint=).*project=/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        count: 1,
        next: null,
        previous: null,
        results: fullTasks(state.duration),
      }),
    }),
  );
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
  await page.route(/\/api\/v1\/projects\/[^/]*\/members\//, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'mem-1', role: 300, role_label: 'Admin' }]),
    }),
  );
  await page.route(/\/api\/v1\/tasks\/[^/]+\/velocity-suggestions\//, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  await page.route(/\/api\/v1\/sprints\/.*\/retro\//, (route) =>
    route.fulfill({ status: 404, contentType: 'application/json', body: '{"detail":"None"}' }),
  );
  await page.route('**/api/v1/me/active-sprints/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );

  return { state, patches };
}

/** Open the backlog row's drawer and gate on the drawer's reads resolving. */
async function openDrawer(page: Page) {
  const backlog = page.getByRole('region', { name: /Sprint Backlog/i });
  await backlog.getByRole('button', { name: /Open Calibrate sensors/i }).click();
  const drawer = page.getByRole('dialog', { name: /Calibrate sensors/i });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByLabel('Task name')).toHaveValue('Calibrate sensors');
  return drawer;
}

test.describe('#2106 — editable Duration in the task detail drawer', () => {
  test('typing a new duration and pressing Enter commits it via PATCH', async ({ page }) => {
    const { patches } = await setup(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(BASE_URL);

    const drawer = await openDrawer(page);

    // At rest, Duration is an edit button (not a plain read-only cell).
    const durationButton = drawer.getByRole('button', { name: /Duration, 5 days\. Edit\./ });
    await expect(durationButton).toBeVisible();
    await durationButton.click();

    const input = drawer.getByRole('textbox', { name: 'Duration in days' });
    await input.fill('12');
    await input.press('Enter');

    // Exactly one PATCH carrying just the duration (id/projectId build the URL,
    // they are stripped from the body by the mutation).
    await expect.poll(() => patches.length).toBe(1);
    expect(patches[0]).toEqual({ duration: 12 });

    // The strip refreshes to the recomputed value (stateful mock), and the
    // commit is announced on the live region.
    await expect(drawer.getByRole('button', { name: /Duration, 12 days\. Edit\./ })).toBeVisible();
    // The commit is announced on the visually-hidden (sr-only) live region.
    await expect(drawer.getByText('Duration set to 12 days. Schedule updated.')).toBeAttached();
  });

  test('invalid input is rejected inline without a PATCH (rule 225)', async ({ page }) => {
    const { patches } = await setup(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(BASE_URL);

    const drawer = await openDrawer(page);
    await drawer.getByRole('button', { name: /Duration, 5 days/ }).click();

    const input = drawer.getByRole('textbox', { name: 'Duration in days' });
    await input.fill('abc');
    await input.press('Enter');

    await expect(drawer.getByRole('alert')).toContainText(/whole number of days/i);
    // Still in edit mode so the user can fix it; nothing was written.
    await expect(drawer.getByRole('textbox', { name: 'Duration in days' })).toBeVisible();
    await page.waitForTimeout(300);
    expect(patches).toHaveLength(0);
  });

  test('a server span-cap 400 surfaces inline (#1862)', async ({ page }) => {
    const { state } = await setup(page);
    state.failMessage = 'Project span cannot exceed the maximum.';
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(BASE_URL);

    const drawer = await openDrawer(page);
    await drawer.getByRole('button', { name: /Duration, 5 days/ }).click();

    const input = drawer.getByRole('textbox', { name: 'Duration in days' });
    await input.fill('9999');
    await input.press('Enter');

    await expect(drawer.getByRole('alert')).toContainText(
      'Project span cannot exceed the maximum.',
    );
  });
});
