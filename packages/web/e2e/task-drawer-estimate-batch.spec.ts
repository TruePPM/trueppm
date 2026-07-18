/**
 * Task detail drawer — three-point estimates batch behind Save (#1985).
 *
 * The Estimates section's Optimistic / Most Likely / Pessimistic inputs used to
 * PATCH immediately on blur. In the desktop task detail drawer they now STAGE
 * behind the drawer's shared Save/Cancel bar (DialogFooter, web-rule 217):
 * editing any of O/M/P raises the bar, each changed field shows a "•"
 * (title="Unsaved") marker, the footer status reads "Unsaved changes: …
 * Estimates", and Save sends ONE PATCH /tasks/:id/ carrying only the changed
 * estimate keys. Cancel reverts. On the FULL-PAGE task view (TaskDetailPage,
 * /projects/:pid/tasks/:tid) there is no Save bar and estimates stay IMMEDIATE
 * (blur → debounced PATCH) because that page mounts no TaskDraftProvider.
 *
 * Host: the Sprints backlog (SprintsView) — the simplest deterministic host for
 * this drawer (a backlog ROW is a plain "Open <name>" button that opens the
 * shared TaskDetailDrawer directly, no canvas hit-testing / drag layer). The
 * mock/auth/fixture setup mirrors e2e/task-drawer-nonmodal-swap.spec.ts and
 * e2e/wave10-sprints-backlog.spec.ts. Scenario 4 reuses the same mocks and
 * navigates directly to the full-page route (mirroring
 * e2e/task-detail-expand.spec.ts's direct-URL approach).
 */
import { test, expect, type Page, type Request } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

const PROJECT_ID = 'e2e-est-batch-00000000-0000-0000-0000-000000000985';
const TASK_ID = 'est-task-a';
const BASE_URL = `/projects/${PROJECT_ID}/sprints`;

const FIXTURE_PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Estimate Batch Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
    methodology: 'AGILE',
  },
];

const PROJECT_DETAIL = {
  id: PROJECT_ID,
  server_version: 1,
  name: 'Estimate Batch Project',
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

// A single IN_PROGRESS backlog row — opening it opens the drawer on TASK_ID.
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

// Full-Task project list (GET /tasks/?project=) — the source both SprintsView's
// taskIndex (to open the drawer) and EstimatesSection (useScheduleTasks.find)
// resolve the task against. Carries a COMPLETE, in-order three-point estimate
// triple (O=3 ≤ M=6 ≤ P=9) so editing one field keeps the triple valid and Save
// stays enabled. can_edit:true so the drawer is editable regardless of role.
const FULL_TASKS = [
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
    optimistic_duration: 3,
    most_likely_duration: 6,
    pessimistic_duration: 9,
  },
];

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
  // specific route below wins). Any unmocked shell endpoint falls through to
  // setupCatchAll's 404 (≠ 401) rather than racily tripping the SessionExpired
  // modal against the shared backend.
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
  // Catch-all /tasks/ FIRST (Playwright last-registered-wins): the specific
  // /tasks/ matches below take precedence.
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
  // useCurrentUserRole hook appends. Admin role (can_edit on the task fixture is
  // the actual editability guarantee).
  await page.route(/\/api\/v1\/projects\/[^/]*\/members\//, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'mem-1', role: 300, role_label: 'Admin' }]),
    }),
  );
  // Velocity suggestions (ADR-0065) — empty so the PM-only prompt never renders.
  await page.route(/\/api\/v1\/tasks\/[^/]+\/velocity-suggestions\//, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  await page.route(/\/api\/v1\/sprints\/.*\/retro\//, (route) =>
    route.fulfill({ status: 404, contentType: 'application/json', body: '{"detail":"None"}' }),
  );
  await page.route('**/api/v1/me/active-sprints/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
}

/**
 * Intercept PATCH /tasks/:id/ and capture each request body. Registered AFTER
 * setup() so it wins (last-registered) for the exact single-task URL; any
 * non-PATCH request that reaches this route falls back to the earlier handlers.
 * The URL regex deliberately excludes query strings and sub-paths so the GET
 * task lists (`/tasks/?project=…`) never match.
 */
async function trackTaskPatches(page: Page): Promise<Array<Record<string, unknown>>> {
  const bodies: Array<Record<string, unknown>> = [];
  await page.route(/\/api\/v1\/tasks\/[^/?]+\/$/, async (route) => {
    const req = route.request();
    if (req.method() !== 'PATCH') return route.fallback();
    bodies.push((req.postDataJSON() ?? {}) as Record<string, unknown>);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: TASK_ID,
        name: 'Calibrate sensors',
        project: PROJECT_ID,
        wbs_path: '1.1',
        duration: 5,
        status: 'IN_PROGRESS',
        percent_complete: 0,
      }),
    });
  });
  return bodies;
}

/** Open the backlog row's drawer and gate on the editable Task name holding the
 *  task's value — a signal that only appears after the drawer's reads resolve. */
async function openDrawer(page: Page) {
  const backlog = page.getByRole('region', { name: /Sprint Backlog/i });
  await backlog.getByRole('button', { name: /Open Calibrate sensors/i }).click();
  const drawer = page.getByRole('dialog', { name: /Calibrate sensors/i });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByLabel('Task name')).toHaveValue('Calibrate sensors');
  return drawer;
}

/** Expand the Estimates accordion in the drawer's Details tab and gate on the
 *  Optimistic input being visible before interacting. */
async function expandEstimates(scope: ReturnType<Page['getByRole']> | Page) {
  await scope.getByRole('button', { name: 'Estimates' }).click();
  await expect(scope.getByLabel('Optimistic (O)')).toBeVisible();
}

test.describe('#1985 — three-point estimates batch behind the drawer Save bar', () => {
  test('editing an estimate stages behind Save — no immediate PATCH on blur', async ({ page }) => {
    await setup(page);
    const patches = await trackTaskPatches(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(BASE_URL);

    const drawer = await openDrawer(page);
    await expandEstimates(drawer);

    const opt = drawer.getByLabel('Optimistic (O)');
    await expect(opt).toHaveValue('3');
    await opt.fill('4');
    // Blur the field — the immediate blur-PATCH path is disabled while bound, so
    // no network write fires; the edit only stages.
    await opt.blur();

    // The shared Save bar (DialogFooter) is now up, scoped to the Estimates edit.
    // The footer status is a <span>; a duplicate sr-only <div role="status">
    // carries the same copy for AT, so scope to the visible span to avoid a
    // strict-mode collision.
    await expect(drawer.getByRole('button', { name: 'Save' })).toBeVisible();
    await expect(
      drawer.locator('span', { hasText: 'Unsaved changes: Estimates' }),
    ).toBeVisible();
    // The changed field carries the "•" unsaved marker (title="Unsaved").
    await expect(drawer.getByTitle('Unsaved')).toBeVisible();

    // Nothing was written — the edit is purely staged. A generous wait clears any
    // hypothetical debounce window before asserting the absence of a PATCH.
    await page.waitForTimeout(400);
    expect(patches).toHaveLength(0);
  });

  test('Save sends ONE PATCH carrying only the changed estimate key, then clears the bar', async ({
    page,
  }) => {
    await setup(page);
    const patches = await trackTaskPatches(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(BASE_URL);

    const drawer = await openDrawer(page);
    await expandEstimates(drawer);

    await drawer.getByLabel('Optimistic (O)').fill('4');
    await expect(drawer.getByRole('button', { name: 'Save' })).toBeEnabled();
    await drawer.getByRole('button', { name: 'Save' }).click();

    // The Save bar clears once the mutation commits (baseline re-snapshot).
    await expect(drawer.getByRole('button', { name: 'Save' })).toHaveCount(0);
    await expect(drawer.getByText(/Unsaved changes/)).toHaveCount(0);

    // Exactly one PATCH, carrying the changed estimate key and NOT the untouched
    // Most Likely / Pessimistic columns.
    expect(patches).toHaveLength(1);
    expect(patches[0].optimistic_duration).toBe(4);
    expect(patches[0]).not.toHaveProperty('most_likely_duration');
    expect(patches[0]).not.toHaveProperty('pessimistic_duration');
    // The input keeps the saved value with no lingering unsaved marker.
    await expect(drawer.getByLabel('Optimistic (O)')).toHaveValue('4');
    await expect(drawer.getByTitle('Unsaved')).toHaveCount(0);
  });

  test('Cancel reverts the staged estimate edit and drops the bar — no PATCH', async ({ page }) => {
    await setup(page);
    const patches = await trackTaskPatches(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(BASE_URL);

    const drawer = await openDrawer(page);
    await expandEstimates(drawer);

    const opt = drawer.getByLabel('Optimistic (O)');
    await opt.fill('4');
    await expect(drawer.getByRole('button', { name: 'Save' })).toBeVisible();

    await drawer.getByRole('button', { name: 'Cancel' }).click();

    // The input returns to its original value and the bar disappears; nothing was
    // written.
    await expect(opt).toHaveValue('3');
    await expect(drawer.getByRole('button', { name: 'Save' })).toHaveCount(0);
    await expect(drawer.getByText(/Unsaved changes/)).toHaveCount(0);
    expect(patches).toHaveLength(0);
  });

  test('full-page estimates stay immediate — blur fires a debounced PATCH, no Save bar', async ({
    page,
  }) => {
    // TaskDetailPage (/projects/:pid/tasks/:tid) mounts no TaskDraftProvider, so
    // EstimatesTab falls back to its immediate blur→debounced-PATCH path. The page
    // is light (just SectionList over the same task list) and reachable directly
    // by URL, so it drives deterministically with the same mock set.
    await setup(page);
    await trackTaskPatches(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/projects/${PROJECT_ID}/tasks/${TASK_ID}`);

    // Gate on the full-page task view having rendered before interacting.
    await expect(page.getByRole('heading', { level: 1, name: /Calibrate sensors/ })).toBeVisible();

    await expandEstimates(page);
    const opt = page.getByLabel('Optimistic (O)');
    await expect(opt).toHaveValue('3');

    // The immediate path debounces 300ms after blur; wait for the write itself.
    const patchPromise: Promise<Request> = page.waitForRequest(
      (req) => req.method() === 'PATCH' && new RegExp(`/tasks/${TASK_ID}/$`).test(req.url()),
    );
    await opt.fill('4');
    await opt.blur();
    const req = await patchPromise;
    expect(req.postDataJSON().optimistic_duration).toBe(4);

    // No Save bar exists on the full page — the edit committed on blur.
    await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(0);
  });
});
