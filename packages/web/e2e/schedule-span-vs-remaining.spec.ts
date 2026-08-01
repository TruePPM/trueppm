/**
 * Task detail drawer — SPAN vs. remaining-work window (#2622, ADR-0752).
 *
 * Since ADR-0132, `early_start`/`early_finish` name the *remaining-work
 * window* for an in-progress task, not its span — a 4-day task at 83% has a
 * one-day `early_start..early_finish`. Nothing distinguished this from the
 * task's actual span, so the Gantt bar shrank instead of filling, and the
 * drawer's Start/Duration cells silently described different quantities.
 *
 * ADR-0752 fixes this with a new `scheduled_start` field naming the span
 * start (the bar now draws from it — see `deriveBarGeometry` in
 * `useScheduleTasks.ts`) and a `remaining_duration` field driving a "Nd left"
 * qualifier chip on the Duration cell (`TaskScheduleStrip.tsx`) rather than a
 * silent contradiction between Start/Finish and Duration.
 *
 * Host: the Sprints backlog (SprintsView) — mirrors the scaffold in
 * e2e/duration-drawer-edit.spec.ts (a backlog row is a plain "Open <name>"
 * button that opens the shared TaskDetailDrawer directly, no canvas
 * hit-testing / drag layer).
 */
import { test, expect, type Page } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

const PROJECT_ID = 'e2e-span-remain-0000-0000-0000-000000002622';
const TASK_ID = 'span-task-a';
const BASE_URL = `/projects/${PROJECT_ID}/sprints`;

const FIXTURE_PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Span vs Remaining Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
    methodology: 'AGILE',
  },
];

const PROJECT_DETAIL = {
  id: PROJECT_ID,
  server_version: 1,
  name: 'Span vs Remaining Project',
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
  name: 'Firmware sweep',
  goal: 'Close out telemetry firmware sweep.',
  start_date: '2026-04-01',
  finish_date: '2026-04-30',
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

// A 4-day task at 83%: early_start/early_finish are the ONE remaining day;
// scheduled_start is where the full 4-day span actually began.
const FULL_TASK = {
  id: TASK_ID,
  name: 'Calibrate sensors',
  wbs_path: '1.1',
  status: 'IN_PROGRESS',
  parent_id: null,
  notes: '',
  early_start: '2026-04-24',
  early_finish: '2026-04-24',
  scheduled_start: '2026-04-21',
  planned_start: null,
  duration: 4,
  remaining_duration: 1,
  percent_complete: 83,
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
};

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
      body: JSON.stringify({ count: 1, next: null, previous: null, results: [FULL_TASK] }),
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

test.describe('#2622/ADR-0752 — schedule SPAN vs. remaining-work window', () => {
  test('the drawer labels the remaining-work window as a qualifier on Duration, not a silent contradiction', async ({
    page,
  }) => {
    await setup(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(BASE_URL);

    const drawer = await openDrawer(page);

    // Duration shows the FULL 4-day estimate — editable strip, so the button's
    // accessible name folds in the remaining-days fact (nested Tooltip cannot
    // sit inside a <button>, see TaskScheduleStrip.tsx).
    const durationButton = drawer.getByRole('button', {
      name: 'Duration, 4 days, 1 day left. Edit.',
    });
    await expect(durationButton).toBeVisible();
    // The visible "Nd left" chip is present as a decorative cue alongside "4d".
    await expect(durationButton.getByText('4d')).toBeVisible();
    await expect(durationButton.getByText('1d left')).toBeVisible();

    // Start reads from the SPAN (scheduled_start = Apr 21), not the
    // remaining-work window (early_start = Apr 24) — the two would have read
    // identically before ADR-0752, hiding four days of already-elapsed work.
    const startCell = drawer.getByRole('group', { name: 'Start' });
    await expect(startCell).toContainText('Apr 21');
    await expect(startCell).not.toContainText('Apr 24');
  });

  test('a not-started task shows no "left" qualifier — remaining equals the full estimate', async ({
    page,
  }) => {
    await setup(page);
    await page.route(/\/api\/v1\/tasks\/\?(?!.*sprint=).*project=/, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          count: 1,
          next: null,
          previous: null,
          results: [
            {
              ...FULL_TASK,
              status: 'NOT_STARTED',
              percent_complete: 0,
              early_start: '2026-04-21',
              early_finish: '2026-04-24',
              scheduled_start: '2026-04-21',
              remaining_duration: 4,
            },
          ],
        }),
      }),
    );
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(BASE_URL);

    const drawer = await openDrawer(page);
    const durationButton = drawer.getByRole('button', { name: 'Duration, 4 days. Edit.' });
    await expect(durationButton).toBeVisible();
    await expect(durationButton.getByText(/left/)).toHaveCount(0);
  });
});
