/**
 * Task detail drawer — editable Actual dates (#3529, ADR-1153).
 *
 * Before this, a user could not state or correct an actual date anywhere in the
 * product: every reference in the web tree was a read surface, and the only ways to
 * change one were an MS Project re-import or a direct API call. The drawer's Actual
 * dates section is now the correction path — deliberately a low-frequency drawer
 * surface rather than a prompt on any of the three completion paths (inline progress,
 * board drag, bulk edit), none of which gains a dialog.
 *
 * Host: the Sprints backlog (SprintsView) — the simplest deterministic host for this
 * drawer (a backlog row is a plain "Open <name>" button that opens the shared
 * TaskDetailDrawer directly, no canvas hit-testing or drag layer). Mock scaffold
 * mirrors e2e/duration-drawer-edit.spec.ts.
 *
 * NOTE on locators: `input[type="date"]` exposes **no** `textbox` role, so every
 * control here is located with `getByLabel`. `getByRole('textbox', …)` finds nothing
 * and fails only at CI runtime — `tsc` cannot see it. `{ exact: true }` is required:
 * Playwright's `getByLabel` is a substring match by default, and the section's own
 * explanatory copy contains both field names.
 */
import { test, expect, type Page } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

const PROJECT_ID = 'e2e-actuals-0000-0000-0000-000000003529';
const TASK_ID = 'actuals-task-a';
const BASE_URL = `/projects/${PROJECT_ID}/sprints`;

const FIXTURE_PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Actual Dates Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
    methodology: 'AGILE',
  },
];

const PROJECT_DETAIL = {
  id: PROJECT_ID,
  server_version: 1,
  name: 'Actual Dates Project',
  description: '',
  start_date: '2026-04-01',
  calendar: null,
  estimation_mode: 'open',
  agile_features: true,
  methodology: 'AGILE',
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
    status: 'COMPLETE',
    story_points: 5,
    is_critical: false,
    assignments: [],
  },
];

interface ActualsState {
  actualStart: string | null;
  actualFinish: string | null;
  status: string;
  failBody: Record<string, string[]> | null;
}

function fullTasks(state: ActualsState) {
  return [
    {
      id: TASK_ID,
      name: 'Calibrate sensors',
      wbs_path: '1.1',
      status: state.status,
      parent_id: null,
      notes: '',
      early_start: '2026-04-05',
      early_finish: '2026-04-10',
      planned_start: '2026-04-05',
      actual_start: state.actualStart,
      actual_finish: state.actualFinish,
      duration: 5,
      percent_complete: 100,
      is_critical: false,
      is_milestone: false,
      is_summary: false,
      assignees: [],
      total_float: 4,
      free_float: 2,
      predecessor_count: 0,
      is_blocked: false,
      linked_risks_count: 0,
      linked_risks_max_severity: null,
      can_edit: true,
    },
  ];
}

/**
 * Install the shared mock scaffold. `state` is the single source of truth for the
 * task's actuals across the GET task lists AND the PATCH response, so a committed
 * edit survives the `['tasks']` invalidation `useUpdateTask.onSuccess` fires. A
 * stateless list mock would re-serve the seed and erase the write within tens of
 * milliseconds — green locally, red on a loaded CI runner (#2752).
 */
async function setup(page: Page, over: Partial<ActualsState> = {}) {
  const state: ActualsState = {
    actualStart: '2026-04-05',
    actualFinish: '2026-04-10',
    status: 'COMPLETE',
    failBody: null,
    ...over,
  };
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

  // PATCH /tasks/:id/ — captured; success folds the written actuals into the shared
  // state so the post-mutation refetch echoes them. The URL regex excludes query
  // strings so the GET task lists never match here.
  await page.route(/\/api\/v1\/tasks\/[^/?]+\/$/, async (route) => {
    const req = route.request();
    if (req.method() !== 'PATCH') return route.fallback();
    const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
    patches.push(body);
    if (state.failBody) {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify(state.failBody),
      });
      return;
    }
    if ('actual_start' in body) state.actualStart = body.actual_start as string | null;
    if ('actual_finish' in body) state.actualFinish = body.actual_finish as string | null;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: TASK_ID,
        name: 'Calibrate sensors',
        project: PROJECT_ID,
        wbs_path: '1.1',
        duration: 5,
        status: state.status,
        percent_complete: 100,
        actual_start: state.actualStart,
        actual_finish: state.actualFinish,
      }),
    });
  });

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
      body: JSON.stringify({ count: 1, next: null, previous: null, results: fullTasks(state) }),
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
        results: BACKLOG_TASKS.map((t) => ({ ...t, status: state.status })),
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
        task_count: 1,
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

/** Open the backlog row's drawer, gate on its reads, and expand Actual dates. */
async function openActualDates(page: Page) {
  const backlog = page.getByRole('region', { name: /Sprint Backlog/i });
  await backlog.getByRole('button', { name: /Open Calibrate sensors/i }).click();
  const drawer = page.getByRole('dialog', { name: /Calibrate sensors/i });
  await expect(drawer).toBeVisible();
  // Gate on a "page rendered" signal before touching drawer chrome, not on the
  // control's own visibility — the sections render only once the task reads land.
  await expect(drawer.getByLabel('Task name')).toHaveValue('Calibrate sensors');

  const header = drawer.getByRole('button', { name: /^Actual dates/i });
  await expect(header).toBeVisible();
  if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click();
  await expect(header).toHaveAttribute('aria-expanded', 'true');
  return drawer;
}

test.describe('#3529 — editable actual dates in the task detail drawer', () => {
  test('correcting an actual finish commits it and survives the refetch', async ({ page }) => {
    const { patches } = await setup(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(BASE_URL);

    const drawer = await openActualDates(page);

    const finish = drawer.getByLabel('Actual finish', { exact: true });
    await expect(finish).toHaveValue('2026-04-10');

    // The motivating case: work really finished on the 8th, the board was updated
    // on the 10th, and this is the only place to say so.
    await finish.fill('2026-04-08');

    await expect.poll(() => patches.length).toBe(1);
    expect(patches[0]).toEqual({ actual_finish: '2026-04-08' });

    // Stateful mock, so this is the value after the onSuccess invalidation refetch —
    // not the optimistic patch that a stateless list mock would erase.
    await expect(finish).toHaveValue('2026-04-08');
    await expect(drawer.getByRole('alert')).toHaveCount(0);
  });

  test('an out-of-order pair is rejected inline without a PATCH', async ({ page }) => {
    const { patches } = await setup(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(BASE_URL);

    const drawer = await openActualDates(page);

    // Finish before start — the client holds both operands, so it refuses without a
    // round trip. The server enforces the same rule for API and agent callers.
    await drawer.getByLabel('Actual finish', { exact: true }).fill('2026-04-01');

    await expect(drawer.getByRole('alert')).toContainText(
      'Actual finish cannot be earlier than actual start (2026-04-05).',
    );
    await page.waitForTimeout(300);
    expect(patches).toHaveLength(0);
  });

  test('a server 400 surfaces inline and keeps the typed value', async ({ page }) => {
    const { state, patches } = await setup(page, { actualStart: null });
    state.failBody = {
      actual_finish: ['Actual finish cannot be in the future (after 2026-09-11).'],
    };
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(BASE_URL);

    const drawer = await openActualDates(page);
    const finish = drawer.getByLabel('Actual finish', { exact: true });
    await finish.fill('2027-01-01');

    // The future bound is `max(project data date, today)` and this component does not
    // load the project, so the rule is server-authoritative by design.
    await expect.poll(() => patches.length).toBe(1);
    await expect(drawer.getByRole('alert')).toContainText(
      'Actual finish cannot be in the future (after 2026-09-11).',
    );
    // The rejected value stays put so the user corrects rather than retypes.
    await expect(finish).toHaveValue('2027-01-01');
  });

  test('actual finish is inert off a sign-off status, with a reachable explanation', async ({
    page,
  }) => {
    await setup(page, { status: 'IN_PROGRESS', actualFinish: null });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(BASE_URL);

    const drawer = await openActualDates(page);

    // engine._is_complete reads `actual_finish is not None`, so a finish on an
    // in-flight task would pin it as done in CPM while the board shows it running.
    // readOnly, not disabled (web-rule 302) — it stays focusable so its explanation,
    // wired via aria-describedby, is reachable by keyboard and screen reader.
    const finish = drawer.getByLabel('Actual finish', { exact: true });
    await expect(finish).toHaveAttribute('readonly', '');
    await expect(finish).toBeEnabled();
    await expect(
      drawer.getByText('Set when the task moves to In review or Complete.'),
    ).toBeVisible();
    // actual_start carries no status gate — ADR-0136 keeps it the permissive half.
    await expect(drawer.getByLabel('Actual start', { exact: true })).not.toHaveAttribute(
      'readonly',
      '',
    );
  });

  test('a missing actual start is never presented as a problem (ADR-0136)', async ({ page }) => {
    await setup(page, { actualStart: null });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(BASE_URL);

    const drawer = await openActualDates(page);

    await expect(drawer.getByLabel('Actual start', { exact: true })).toHaveValue('');
    await expect(drawer.getByRole('alert')).toHaveCount(0);
    await expect(drawer.getByText(/A finish with no start is normal/)).toBeVisible();
  });
});
