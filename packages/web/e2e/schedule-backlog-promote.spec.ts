import { test, expect } from './fixtures/coverage';
import { setupCatchAll } from './fixtures';

/**
 * E2E for the Schedule view backlog-promote feature (#318).
 *
 * Covers:
 *  (a) a BACKLOG task appears in the gutter's Backlog section and dragging the
 *      dashed chip onto the timeline issues the promote PATCH + success toast;
 *  (b) the keyboard "Schedule…" dialog golden path (rule 135);
 *  (c) an offline state — the Schedule button is disabled in the dialog.
 *
 * The promote PATCH sends { planned_start, status: 'NOT_STARTED' } (decision
 * A2): an explicit status skips the server's date-gated → IN_PROGRESS bump so
 * a backlog idea lands deterministically in To Do.
 */

const FIXTURE_PROJECT_ID = 'e2e-fixture-00000000-0000-0000-0000-000000000001';

const FIXTURE_API_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Backlog Promote Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

/** One scheduled task (so the canvas paints), one To Do gutter task, and two
 *  BACKLOG ideas (so the Backlog gutter section is populated). */
const FIXTURE_API_TASKS = [
  {
    id: 't1',
    wbs_path: '1',
    name: 'Design Sprint',
    early_start: '2026-04-07',
    early_finish: '2026-04-21',
    planned_start: '2026-04-07',
    duration: 14,
    percent_complete: 40,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    status: 'IN_PROGRESS',
    actual_start: null,
    actual_finish: null,
    schedule_variance_days: null,
    baseline_start: null,
    baseline_finish: null,
    optimistic_duration: null,
    most_likely_duration: null,
    pessimistic_duration: null,
    estimate_status: null,
    total_float: 5,
    assignee_is_overallocated: false,
    assignments: [],
  },
  {
    id: 't2',
    wbs_path: '2',
    name: 'Wire Login Form',
    early_start: null,
    early_finish: null,
    planned_start: null,
    duration: 5,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    status: 'NOT_STARTED',
    actual_start: null,
    actual_finish: null,
    schedule_variance_days: null,
    baseline_start: null,
    baseline_finish: null,
    optimistic_duration: null,
    most_likely_duration: null,
    pessimistic_duration: null,
    estimate_status: null,
    total_float: null,
    assignee_is_overallocated: false,
    assignments: [],
  },
  {
    id: 'bk1',
    wbs_path: '3',
    name: 'Spike Auth Provider',
    early_start: null,
    early_finish: null,
    planned_start: null,
    duration: 3,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    status: 'BACKLOG',
    readiness: 'idea',
    actual_start: null,
    actual_finish: null,
    schedule_variance_days: null,
    baseline_start: null,
    baseline_finish: null,
    optimistic_duration: null,
    most_likely_duration: null,
    pessimistic_duration: null,
    estimate_status: null,
    total_float: null,
    assignee_is_overallocated: false,
    assignments: [],
  },
  {
    id: 'bk2',
    wbs_path: '4',
    name: 'Research Offline Sync',
    early_start: null,
    early_finish: null,
    planned_start: null,
    duration: 8,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    status: 'BACKLOG',
    readiness: 'estimated',
    actual_start: null,
    actual_finish: null,
    schedule_variance_days: null,
    baseline_start: null,
    baseline_finish: null,
    optimistic_duration: null,
    most_likely_duration: null,
    pessimistic_duration: null,
    estimate_status: null,
    total_float: null,
    assignee_is_overallocated: false,
    assignments: [],
  },
];

async function setupRoutes(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.removeItem('trueppm.gantt.unscheduledGutter.collapsed');
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
      status: 200,
      contentType: 'application/json',
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
        task_count: FIXTURE_API_TASKS.length,
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
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        schedule_health: 'unknown',
        spi: null,
        tasks_late_count: 0,
        critical_task_count: 0,
        total_tasks: FIXTURE_API_TASKS.length,
        complete_tasks: 0,
        next_milestone: null,
        team_utilization_pct: null,
        owner_name: null,
        start_date: '2026-01-01',
      }),
    }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/attention/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [] }),
    }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/my-tasks/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ tasks: [] }),
    }),
  );
  // PATCH on a specific task is intercepted per-test where the body is asserted;
  // the catch-all returns the task list for GETs. This handler is registered
  // *after* the per-test PATCH route (via gotoSchedule), and Playwright runs the
  // most-recently-added handler first — so non-GET requests must `fallback()`
  // (hand off to the earlier, more specific handler), not `continue()` (which
  // would send the PATCH to the network and bypass the per-test mock).
  await page.route('**/api/v1/tasks/**', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        count: FIXTURE_API_TASKS.length,
        next: null,
        previous: null,
        results: FIXTURE_API_TASKS,
      }),
    });
  });
  await page.route('**/api/v1/dependencies/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    }),
  );

  // ── Ambient reads the Schedule route makes beyond the task fixtures (#2367) ──
  //
  // This spec previously registered no catch-all and let these escape to the
  // preview server, which answered 401 and tripped the session-expired modal —
  // a dialog that then covers the page and swallows every subsequent click.
  // That is why it passed alone and failed under parallel load. Each is mocked
  // with its real response shape rather than left to the catch-all's 404.
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
  await page.route('**/api/v1/edition/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ edition: 'community' }),
    }),
  );
  await page.route('**/api/v1/workspace/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        name: 'E2E Workspace',
        subdomain: 'e2e',
        timezone: '',
        fiscal_year_start_month: 1,
        fiscal_year_start_day: 1,
        fiscal_year_start_display: 'January 1',
        work_week: [true, true, true, true, true, false, false],
        default_project_view: 'SCHEDULE',
        allow_guests: false,
        public_sharing: false,
        public_sharing_override_policy: 'suggest',
        iteration_label: 'Sprint',
        iteration_label_override_policy: 'suggest',
        mc_history_enabled: true,
        mc_history_retention_cap: 50,
        mc_history_attribution_audience: 'scheduler_plus',
        mc_history_override_policy: 'suggest',
        task_duration_change_percent_policy: 'confirm',
        task_duration_change_percent_override_policy: 'suggest',
        estimation_scale: 'fibonacci',
        methodology: 'HYBRID',
        methodology_override_policy: 'suggest',
        attachments_enabled: true,
        allowed_attachment_types: [],
        attachments_override_policy: 'suggest',
        calendar: null,
        calendar_override_policy: 'suggest',
        logo_url: null,
      }),
    }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: FIXTURE_PROJECT_ID,
        server_version: 1,
        name: 'Schedule Fixture Project',
        description: '',
        start_date: '2026-04-01',
        calendar: null,
        program: null,
        program_detail: null,
        health: 'ON_TRACK',
        methodology: 'HYBRID',
        effective_methodology: 'HYBRID',
        estimation_mode: 'open',
        agile_features: true,
      }),
    }),
  );
  // `?self=true` needs its own route: a glob ending in `/` never matches a
  // query string, so the bare members glob does not cover it.
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/members/?*`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'mem-1', role: 300, role_label: 'Scheduler' }]),
    }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/members/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'mem-1', role: 300, role_label: 'Scheduler' }]),
    }),
  );
  for (const path of ['sprints', 'baselines', 'velocity']) {
    await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/${path}/`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
      }),
    );
  }
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/monte-carlo/latest/`, (route) =>
    route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: '{"detail":"Not found."}',
    }),
  );
  // Fire-and-forget; the page never reads the result.
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/visit/`, (route) =>
    route.fulfill({ status: 204, body: '' }),
  );
  await page.route('**/api/v1/me/timer/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ active: false }),
    }),
  );
  await page.route('**/api/v1/me/work/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        count: 0,
        next: null,
        previous: null,
        results: [],
        due_today_count: 0,
      }),
    }),
  );
  await page.route('**/api/v1/me/active-sprints/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  await page.route('**/api/v1/me/notifications/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, results: [] }),
    }),
  );
  await page.route('**/api/v1/programs/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
  await page.route('**/api/v1/auth/me/pinned/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  await page.route('**/api/v1/ws/ticket/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ticket: 'e2e' }),
    }),
  );
}

async function gotoSchedule(page: import('@playwright/test').Page) {
  await setupRoutes(page);
  await page.goto(`/projects/${FIXTURE_PROJECT_ID}/schedule`);
  await expect(page.getByRole('treegrid', { name: 'Task list' })).toBeVisible({ timeout: 10_000 });
}

// ---------------------------------------------------------------------------
// (a) Backlog section + drag-to-promote
// ---------------------------------------------------------------------------

/**
 * The catch-all must be the FIRST route registered in each test (#2367).
 *
 * Playwright runs the LAST-registered matching handler first, so registering it
 * inside `setupRoutes` — which several tests call *after* their own
 * `**\/api\/v1\/tasks\/bk1\/` PATCH handler — makes the catch-all outrank the
 * per-test mock and swallow the very request the test asserts on. A file-level
 * `beforeEach` runs before any test body, which puts it at the bottom of the
 * priority stack where a fall-through guard belongs.
 */
test.beforeEach(async ({ page }) => {
  await setupCatchAll(page);
});

test.describe('Schedule backlog gutter section (#318)', () => {
  test('backlog tasks appear in the Backlog section, To Do tasks in the To Do section', async ({
    page,
  }) => {
    await gotoSchedule(page);

    const backlogSection = page.getByRole('group', { name: /Backlog, 2 items/i });
    await expect(backlogSection.getByText('Spike Auth Provider')).toBeVisible();
    await expect(backlogSection.getByText('Research Offline Sync')).toBeVisible();

    const todoSection = page.getByRole('group', { name: /To do, unscheduled, 1 task/i });
    await expect(todoSection.getByText('Wire Login Form')).toBeVisible();

    // Header count is the sum of both sections (1 To Do + 2 Backlog).
    await expect(page.getByText('(3)')).toBeVisible();
  });

  test('dragging a backlog chip onto the timeline promotes it and shows the success toast', async ({
    page,
  }) => {
    let patchBody: Record<string, unknown> | null = null;
    await page.route('**/api/v1/tasks/bk1/', async (route) => {
      if (route.request().method() === 'PATCH') {
        patchBody = (await route.request().postDataJSON()) as Record<string, unknown>;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: 'bk1',
            name: 'Spike Auth Provider',
            project: FIXTURE_PROJECT_ID,
            wbs_path: '3',
            duration: 3,
            status: 'NOT_STARTED',
            percent_complete: 0,
          }),
        });
      } else {
        await route.continue();
      }
    });

    await gotoSchedule(page);

    const chip = page
      .getByRole('group', { name: /Backlog, 2 items/i })
      .getByText('Spike Auth Provider');
    const canvas = page.getByTestId('schedule-canvas-scroll');
    await expect(canvas).toBeVisible();

    const chipBox = await chip.boundingBox();
    const canvasBox = await canvas.boundingBox();
    if (!chipBox || !canvasBox) throw new Error('missing bounding boxes');

    // Pointer-events drag. The gutter attaches its window pointermove/pointerup
    // listeners in a useEffect keyed on drag state, so we must let that state
    // render before moving over the canvas — otherwise the canvas move races the
    // listener attach and the drop is silently lost (the CI-only failure mode).
    // Two visible-overlay gates make the drag deterministic:
    //   1) the floating preview proves the drag state rendered (listeners attached);
    //   2) the drop indicator proves overCanvas + dropDate registered before release.
    await page.mouse.move(chipBox.x + chipBox.width / 2, chipBox.y + chipBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(chipBox.x + chipBox.width / 2 + 12, chipBox.y + chipBox.height / 2, {
      steps: 3,
    });
    await expect(page.getByTestId('schedule-drag-preview')).toBeVisible();
    await page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2, {
      steps: 8,
    });
    await expect(page.getByTestId('schedule-drop-indicator')).toBeVisible();
    await page.mouse.up();

    // Success toast uses the fixed verb ("to To Do").
    await expect(page.getByText(/Added 'Spike Auth Provider' to the sprint, starting/)).toBeVisible(
      { timeout: 5_000 },
    );

    expect(patchBody).not.toBeNull();
    expect(patchBody!.status).toBe('NOT_STARTED');
    expect(typeof patchBody!.planned_start).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// (b) Keyboard "Schedule…" dialog golden path (rule 135)
// ---------------------------------------------------------------------------

test.describe('Schedule "…" dialog (#318, rule 135)', () => {
  test('opening the dialog from a backlog chip and confirming promotes the task', async ({
    page,
  }) => {
    let patchBody: Record<string, unknown> | null = null;
    await page.route('**/api/v1/tasks/bk1/', async (route) => {
      if (route.request().method() === 'PATCH') {
        patchBody = (await route.request().postDataJSON()) as Record<string, unknown>;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: 'bk1',
            name: 'Spike Auth Provider',
            project: FIXTURE_PROJECT_ID,
            wbs_path: '3',
            duration: 3,
            status: 'NOT_STARTED',
            percent_complete: 0,
          }),
        });
      } else {
        await route.continue();
      }
    });

    await gotoSchedule(page);

    await page.getByRole('button', { name: 'Actions for Spike Auth Provider' }).click();

    // Scope to the Schedule dialog by its accessible name — the schedule view
    // always renders a closed TaskDetailDrawer (role="dialog", empty name) that
    // an unscoped getByRole('dialog') collides with on desktop viewports.
    const dialog = page.getByRole('dialog', { name: /to a sprint$/ });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByText('This commits the idea from your backlog to a sprint'),
    ).toBeVisible();

    await dialog.getByLabel('Target date').fill('2026-06-15');
    await dialog.getByRole('button', { name: 'Add to sprint' }).click();

    await expect(dialog).not.toBeVisible();
    await expect(page.getByText(/Added 'Spike Auth Provider' to the sprint, starting/)).toBeVisible(
      { timeout: 5_000 },
    );

    expect(patchBody).toEqual({ planned_start: '2026-06-15', status: 'NOT_STARTED' });
  });

  test('Esc cancels the dialog', async ({ page }) => {
    await gotoSchedule(page);
    await page.getByRole('button', { name: 'Actions for Spike Auth Provider' }).click();
    const dialog = page.getByRole('dialog', { name: /to a sprint$/ });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// (c) Offline state
// ---------------------------------------------------------------------------

test.describe('Schedule "…" dialog offline (#318, rule 29)', () => {
  test('Schedule button is disabled while offline', async ({ page }) => {
    await gotoSchedule(page);
    // Flip the browser offline so navigator.onLine is false in the dialog.
    await page.context().setOffline(true);

    await page.getByRole('button', { name: 'Actions for Spike Auth Provider' }).click();
    const dialog = page.getByRole('dialog', { name: /to a sprint$/ });
    await expect(dialog).toBeVisible();

    const scheduleBtn = dialog.getByRole('button', { name: 'Add to sprint' });
    await expect(scheduleBtn).toBeDisabled();
    await expect(scheduleBtn).toHaveAttribute('title', "You're offline — change not saved.");

    await page.context().setOffline(false);
  });
});
