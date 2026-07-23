import { test, expect, type Page } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * E2E coverage for the redesigned TaskDetailDrawer (#962, "Direction B").
 *
 * The drawer groups the registry-driven sections (ADR-0050) into four tabs —
 * Details / Subtasks / Activity / Files. Details is active by default and
 * carries the schedule strip + a deferred-save Description field above its
 * registered sections. Within a tab the first section is expanded and the rest
 * start collapsed (ADR-0050 lazy-load, preserved tab-by-tab). The header shows
 * the WBS pill, readiness/CP chips, and an editable task-name input. A
 * Settings-style save bar appears while the Description is dirty.
 *
 * All API calls are intercepted with Playwright route mocking.
 */

const FIXTURE_PROJECT_ID = 'e2e-fixture-00000000-0000-0000-0000-000000000001';

const FIXTURE_API_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Alpha Platform Upgrade',
    description: '',
    start_date: '2026-01-01',
    calendar: 'default',
    estimation_mode: 'open',
  },
];

const FIXTURE_API_TASKS = [
  {
    id: 't1',
    wbs_path: '1',
    name: 'Discovery & Design',
    early_start: '2026-10-05',
    early_finish: '2026-10-16',
    duration: 10,
    percent_complete: 50,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    actual_start: null,
    actual_finish: null,
    schedule_variance_days: null,
    baseline_start: null,
    baseline_finish: null,
    optimistic_duration: 7,
    most_likely_duration: 10,
    pessimistic_duration: 15,
    estimate_status: null,
    status: 'IN_PROGRESS',
    planned_start: null,
    assignments: [],
  },
  {
    id: 't2',
    wbs_path: '2',
    name: 'Backend Implementation',
    early_start: '2026-10-19',
    early_finish: '2026-10-30',
    duration: 10,
    percent_complete: 0,
    total_float: 0,
    is_critical: true,
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    actual_start: null,
    actual_finish: null,
    schedule_variance_days: null,
    baseline_start: null,
    baseline_finish: null,
    optimistic_duration: null,
    most_likely_duration: null,
    pessimistic_duration: null,
    estimate_status: null,
    status: 'NOT_STARTED',
    planned_start: null,
    assignments: [],
  },
];

// Merged activity feed (#1883): every entry carries {event_type, actor,
// timestamp, detail}; the field-diff entry additionally keeps its legacy keys.
const FIXTURE_HISTORY = {
  count: 4,
  next: null,
  previous: null,
  count_truncated: false,
  results: [
    {
      event_type: 'comment_edited',
      actor: { id: 'u-erin', display_name: 'Erin' },
      timestamp: '2026-04-25T13:00:00Z',
      detail: { comment_id: 'c1', preview: 'Reworded take' },
    },
    {
      event_type: 'risk_linked',
      actor: { id: 'u-bob', display_name: 'Bob' },
      timestamp: '2026-04-25T12:00:00Z',
      detail: { risk_id: 'r1', risk_short_id: 'R-7', risk_title: 'Vendor slip' },
    },
    {
      event_type: 'cpm_recalculated',
      actor: null,
      timestamp: '2026-04-25T11:00:00Z',
      detail: {
        early_finish: { from: '2026-06-01', to: '2026-06-03' },
        is_critical: true,
        // #1948 per-project recalc summary.
        recalc_moved_count: 5,
        recalc_finish: '2026-06-03',
        recalc_finish_delta_days: 2,
      },
    },
    {
      id: 1,
      event_type: 'fields_changed',
      actor: { id: 'u-alice', display_name: 'alice' },
      timestamp: '2026-04-25T10:00:00Z',
      history_date: '2026-04-25T10:00:00Z',
      history_type: '~',
      history_user: 'alice',
      history_user_display: 'alice',
      detail: { diff: [{ field: 'duration', old: '8', new: '10' }] },
      diff: [{ field: 'duration', old: '8', new: '10' }],
    },
  ],
};

async function gotoSchedule(page: Page, opts: { role?: number; canEdit?: boolean } = {}) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });

  // Hermetic 401-guard net, registered FIRST so every specific route below wins
  // (Playwright matches routes LIFO). Any endpoint the app-wide shell reads that
  // this spec does not mock would otherwise fall through Vite's proxy to a real
  // backend on :8000, take a genuine 401 for the fixture token, and racily trip
  // the SessionExpired modal — which then intercepts every click. The 404 keeps
  // requests hermetic (404 ≠ 401, so no session-expired cascade).
  await setupCatchAll(page);

  // Boot-time auth endpoints. Without these, an unmocked GET /auth/me/ (and its
  // failed token refresh) trips the session-expired modal, which then intercepts
  // pointer events and flakily fails clicks across the whole spec. Stubbing them
  // makes the drawer specs deterministic locally and in CI.
  await page.route('**/api/v1/auth/token/refresh/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ access: 'e2e-access' }),
    }),
  );
  await page.route('**/api/v1/auth/me/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 1,
        username: 'e2e',
        email: 'e2e@example.com',
        workspace_role: opts.role ?? 300,
      }),
    }),
  );
  await page.route('**/api/v1/me/notifications/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
  // App-wide shell subscriptions mounted on every routed page. Left unmocked
  // these churn (WS ticket → reconnect loop; edition/active-sprints → retry),
  // which eats the timing slack and lets an unmocked-endpoint 401 cascade win
  // the race into the SessionExpired modal that then intercepts clicks.
  await page.route('**/api/v1/ws/ticket/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ticket: 'e2e-ticket', expires_in: 30 }),
    }),
  );
  await page.route('**/api/v1/edition/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ edition: 'community' }),
    }),
  );
  await page.route('**/api/v1/me/active-sprints/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );

  await page.route('**/api/v1/projects/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 1, next: null, previous: null, results: FIXTURE_API_PROJECTS }),
    }),
  );
  // Project detail — ProjectShell gates the whole route on this query. Under the
  // 404 net an unmocked object endpoint 404s, retry-remounting the page (and the
  // Description save bar) mid-interaction. Object shape mirrors schedule.spec.ts.
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: FIXTURE_PROJECT_ID,
        name: 'Alpha Platform Upgrade',
        description: '',
        start_date: '2026-01-01',
        calendar: 'default',
        estimation_mode: 'OPEN',
        agile_features: false,
        methodology: 'WATERFALL',
        code: '',
        health: 'AUTO',
        visibility: 'WORKSPACE',
        timezone: '',
        default_view: 'SCHEDULE',
        lead: null,
        lead_detail: null,
        iteration_label: 'Sprint',
        is_archived: false,
        archived_at: null,
        archived_by: null,
        recalculated_at: null,
        is_sample: false,
        program_detail: null,
        server_version: 1,
      }),
    }),
  );
  // Schedule-page + shell sub-resources that otherwise 404-churn under the net.
  await page.route('**/api/v1/projects/*/sprints/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
  await page.route('**/api/v1/projects/*/velocity/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  await page.route('**/api/v1/projects/*/monte-carlo/latest/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(null) }),
  );
  await page.route('**/api/v1/projects/*/visit/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) }),
  );
  await page.route('**/api/v1/projects/*/presence/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  // #1046: the drawer threads the caller's project role (GET members/?self=true)
  // to gate write controls. Without this mock the role never resolves, the
  // Description editor stays read-only, and editing specs time out on fill().
  await page.route('**/api/v1/projects/*/members/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'mem-self', role: opts.role ?? 300 }]),
    }),
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
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/overview/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        schedule_health: 'unknown',
        spi: null,
        tasks_late_count: 0,
        critical_task_count: 0,
        total_tasks: 0,
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
  // Stateful task store for this page: useUpdateTask invalidates and refetches
  // the list on save, so the PATCH must persist into the copy the GET returns —
  // otherwise the saved notes never round-trip and the dirty save-bar never
  // clears. Deep-clone so concurrent specs never share mutated fixtures.
  // ADR-0133: when the caller drives a capability, stamp the server-derived
  // can_edit/can_delete onto the task rows so the drawer gates off the
  // authoritative field (not just the role fallback).
  const tasks = FIXTURE_API_TASKS.map((t) => ({
    ...t,
    ...(opts.canEdit !== undefined ? { can_edit: opts.canEdit, can_delete: opts.canEdit } : {}),
  }));
  await page.route('**/api/v1/tasks/**', (route) => {
    const request = route.request();
    if (request.method() === 'PATCH') {
      // URL is .../api/v1/tasks/{id}/ — apply the body to the stored task so the
      // subsequent list refetch reflects the edit.
      const id = new URL(request.url()).pathname.split('/').filter(Boolean).pop();
      const target = tasks.find((t) => t.id === id) ?? tasks[0];
      Object.assign(target, request.postDataJSON() ?? {});
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(target),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        count: tasks.length,
        next: null,
        previous: null,
        results: tasks,
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
  await page.route('**/api/v1/task-resources/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
  await page.route('**/api/v1/resources/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
  await page.route('**/tasks/*/history/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(FIXTURE_HISTORY),
    }),
  );
  // The unified Activity timeline (#869) merges history + comments; mock the
  // second feed so its read resolves (empty here — the audit assertions use
  // FIXTURE_HISTORY).
  await page.route('**/tasks/*/comments/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
  await page.route('**/tasks/*/baseline/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ has_baseline: false }),
    }),
  );
  // Accept and hold the project WebSocket open. Without this the socket fails to
  // connect against the preview server, reconnect-loops, and repeatedly
  // re-renders the drawer — which detaches the save bar mid-click and fails the
  // Description interaction specs. Leaving it open makes the client fire `open`
  // and settle (schedule.spec.ts pattern).
  await page.routeWebSocket('**/ws/v1/projects/**', () => {
    /* accept and hold the connection open */
  });

  await page.goto(`/projects/${FIXTURE_PROJECT_ID}/schedule`);
}

async function openDrawer(page: Page, taskName: string) {
  const grid = page.getByRole('grid', { name: 'Task list' });
  await expect(grid).toBeVisible({ timeout: 10_000 });
  await grid.getByText(taskName, { exact: true }).click();
  const drawer = page.getByRole('dialog', { name: new RegExp(taskName) }).first();
  await expect(drawer).toBeVisible({ timeout: 5_000 });
  return drawer;
}

test.describe('TaskDetailDrawer redesign — tabs', () => {
  test.beforeEach(async ({ page }) => {
    await gotoSchedule(page);
  });

  test('renders the four tabs with Details active by default', async ({ page }) => {
    const drawer = await openDrawer(page, 'Discovery & Design');
    for (const name of ['Details', 'Subtasks', 'Activity', 'Files']) {
      await expect(drawer.getByRole('tab', { name: new RegExp(`^${name}`) })).toBeVisible();
    }
    await expect(drawer.getByRole('tab', { name: 'Details' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  test('tabs expose the ARIA tab/tabpanel relationship and arrow-key navigation (#1022)', async ({
    page,
  }) => {
    const drawer = await openDrawer(page, 'Discovery & Design');

    // The active panel is a tabpanel labelled by the active tab; the tab controls it.
    const details = drawer.getByRole('tab', { name: 'Details' });
    await expect(details).toHaveAttribute('aria-controls', 'drawer-panel-details');
    const panel = drawer.getByRole('tabpanel');
    await expect(panel).toHaveAttribute('id', 'drawer-panel-details');
    await expect(panel).toHaveAttribute('aria-labelledby', 'drawer-tab-details');

    // ArrowRight moves selection to the next tab without leaving the tablist.
    await details.focus();
    await page.keyboard.press('ArrowRight');
    await expect(drawer.getByRole('tab', { name: /^Subtasks/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(drawer.getByRole('tabpanel')).toHaveAttribute(
      'aria-labelledby',
      'drawer-tab-subtasks',
    );

    // ArrowLeft returns selection to Details.
    await page.keyboard.press('ArrowLeft');
    await expect(details).toHaveAttribute('aria-selected', 'true');
  });

  test('header renders WBS pill and an editable task-name input', async ({ page }) => {
    const drawer = await openDrawer(page, 'Discovery & Design');
    await expect(drawer.getByText('1', { exact: true })).toBeVisible();
    await expect(drawer.getByRole('textbox', { name: 'Task name' })).toHaveValue(
      'Discovery & Design',
    );
  });

  test('Details tab shows the schedule strip and (open) Overview assignees', async ({ page }) => {
    const drawer = await openDrawer(page, 'Discovery & Design');
    // Schedule strip cells (group per cell). Scope to the Schedule group — the
    // at-a-glance summary strip (#2315) has its own "Finish" cell above this one.
    // Duration is the editable cell for a non-milestone task the user can edit
    // (#2106) — a button, not a group.
    const schedule = drawer.getByRole('group', { name: 'Schedule', exact: true });
    for (const label of ['Start', 'Finish', 'Float']) {
      await expect(schedule.getByRole('group', { name: label })).toBeVisible();
    }
    await expect(schedule.getByRole('button', { name: /Duration, 10 days\. Edit\./ })).toBeVisible();
    await expect(drawer.getByText('10d', { exact: true })).toBeVisible();
    // Overview is the first Details section → expanded → Assignees visible.
    await expect(drawer.getByRole('region', { name: 'Assignees' })).toBeVisible();
  });

  test('critical task shows the CP marker in the schedule strip', async ({ page }) => {
    const drawer = await openDrawer(page, 'Backend Implementation');
    await expect(drawer.getByText('CP', { exact: true }).first()).toBeVisible();
    await expect(drawer.getByText(/On the critical path/i)).toBeVisible();
  });

  // #2172 — keyboard-stepping the progress slider must debounce to a single
  // PATCH, not fire one request per arrow keyup.
  test('keyboard-stepping the progress slider issues a single debounced PATCH', async ({
    page,
  }) => {
    let progressPatches = 0;
    page.on('request', (req) => {
      if (req.method() !== 'PATCH' || !/\/tasks\/[^/]+\//.test(req.url())) return;
      let body: Record<string, unknown> | null = null;
      try {
        body = req.postDataJSON() as Record<string, unknown> | null;
      } catch {
        body = null;
      }
      if (body && 'percent_complete' in body) progressPatches++;
    });

    const drawer = await openDrawer(page, 'Discovery & Design');
    const slider = drawer.getByRole('slider', { name: /Task progress/i });
    await expect(slider).toBeVisible();
    await slider.focus();

    // Five discrete keyboard steps. The old handler committed on every keyup → 5
    // PATCHes; the debounced handler collapses them to one.
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('ArrowRight');
    }
    // Wait past the 500ms debounce window, then assert exactly one commit fired.
    await page.waitForTimeout(800);
    expect(progressPatches).toBe(1);
  });
});

test.describe('TaskDetailDrawer redesign — tab grouping', () => {
  test.beforeEach(async ({ page }) => {
    await gotoSchedule(page);
  });

  test('Dependencies + Estimates live under the Details tab', async ({ page }) => {
    const drawer = await openDrawer(page, 'Discovery & Design');
    await expect(drawer.getByRole('button', { name: 'Dependencies' })).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Estimates' })).toBeVisible();
  });

  test('Attachments + External links live under the Files tab', async ({ page }) => {
    const drawer = await openDrawer(page, 'Discovery & Design');
    // Not present on the default Details tab.
    await expect(drawer.getByRole('button', { name: 'External links' })).toHaveCount(0);
    await drawer.getByRole('tab', { name: 'Files' }).click();
    await expect(drawer.getByRole('button', { name: 'Attachments' })).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'External links' })).toBeVisible();
  });

  test('Comments + Activity live under the Activity tab (History merged into Activity, #869)', async ({
    page,
  }) => {
    const drawer = await openDrawer(page, 'Discovery & Design');
    await drawer.getByRole('tab', { name: 'Activity' }).click();
    await expect(drawer.getByRole('button', { name: 'Comments' })).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Activity' })).toBeVisible();
    // The former standalone History section is gone — its records now live in Activity.
    await expect(drawer.getByRole('button', { name: 'History' })).toHaveCount(0);
  });

  test('Activity timeline surfaces merged events (schedule/risk/comment lifecycle)', async ({
    page,
  }) => {
    const drawer = await openDrawer(page, 'Discovery & Design');
    await drawer.getByRole('tab', { name: 'Activity' }).click();
    await drawer.getByRole('button', { name: 'Activity' }).click();
    // Field-diff change renders inline (single-field duration change).
    await expect(drawer.getByText(/changed duration/i)).toBeVisible({ timeout: 5_000 });
    // #1883: schedule + risk streams now surface, and edited comments appear —
    // none of these rendered before ?include= was adopted.
    await expect(drawer.getByRole('radio', { name: 'Schedule' })).toBeVisible();
    await expect(drawer.getByRole('radio', { name: 'Risks' })).toBeVisible();
    await expect(drawer.getByText(/recalculated the schedule/i)).toBeVisible();
    // #1948: the recalc row names what moved and links into the schedule.
    await expect(drawer.getByText(/5 tasks moved · finish \+2d/)).toBeVisible();
    await expect(drawer.getByText(/linked a risk/i)).toBeVisible();
    await expect(drawer.getByText(/edited a comment/i)).toBeVisible();
  });

  test('the recalc row links into the schedule', async ({ page }) => {
    const drawer = await openDrawer(page, 'Discovery & Design');
    await drawer.getByRole('tab', { name: 'Activity' }).click();
    await drawer.getByRole('button', { name: 'Activity' }).click();
    const link = drawer.getByRole('link', { name: /View in schedule/i });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', `/projects/${FIXTURE_PROJECT_ID}/schedule`);
  });

  test('Overview is rendered inline (no accordion); secondary sections start collapsed', async ({
    page,
  }) => {
    const drawer = await openDrawer(page, 'Discovery & Design');
    // Overview work-state is curated inline — there is no "Overview" accordion
    // button; its Assignees region is visible directly.
    await expect(drawer.getByRole('button', { name: 'Overview' })).toHaveCount(0);
    await expect(drawer.getByRole('region', { name: 'Assignees' })).toBeVisible();
    // Dependencies (a secondary Details section) starts collapsed.
    await expect(drawer.getByRole('button', { name: 'Dependencies' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });
});

test.describe('TaskDetailDrawer redesign — Save/Cancel (#1977)', () => {
  test.beforeEach(async ({ page }) => {
    await gotoSchedule(page);
  });

  test('typing in Description reveals the shared save bar; Cancel reverts it', async ({ page }) => {
    const drawer = await openDrawer(page, 'Discovery & Design');
    // Issue 1048: the Description is a Markdown read/edit swap — click the
    // rendered block to reveal the textarea.
    await drawer.getByRole('button', { name: 'Description' }).click();
    const description = drawer.getByRole('textbox', { name: 'Description' });
    await expect(description).toBeVisible();

    // No save bar while clean.
    await expect(drawer.getByRole('button', { name: 'Save' })).toHaveCount(0);

    await description.fill('Validate Phase-2 scope with the steering committee.');
    // The shared DialogFooter appears; its status names the changed field.
    await expect(drawer.getByRole('button', { name: 'Save' })).toBeVisible();
    await expect(drawer.getByText('Unsaved changes: Description').first()).toBeVisible();

    await drawer.getByRole('button', { name: 'Cancel' }).click();
    // Reverted to the saved (empty) value and the bar is gone.
    await expect(drawer.getByRole('button', { name: 'Save' })).toHaveCount(0);
    await expect(drawer.getByRole('button', { name: 'Description' })).toContainText(
      'Add a description',
    );
  });

  test('Save persists the Description edit and clears the bar', async ({ page }) => {
    const drawer = await openDrawer(page, 'Discovery & Design');
    await drawer.getByRole('button', { name: 'Description' }).click();
    const description = drawer.getByRole('textbox', { name: 'Description' });
    await description.fill('A new description.');
    await drawer.getByRole('button', { name: 'Save' }).click();
    await expect(drawer.getByRole('button', { name: 'Save' })).toHaveCount(0, { timeout: 5_000 });
  });

  test('editing the task name reveals the bar and Save persists it', async ({ page }) => {
    const drawer = await openDrawer(page, 'Discovery & Design');
    const name = drawer.getByRole('textbox', { name: 'Task name' });
    await name.fill('Discovery & Design v2');
    await expect(drawer.getByText('Unsaved changes: Name').first()).toBeVisible();
    await drawer.getByRole('button', { name: 'Save' }).click();
    await expect(drawer.getByRole('button', { name: 'Save' })).toHaveCount(0, { timeout: 5_000 });
    await expect(name).toHaveValue('Discovery & Design v2');
  });

  test('Esc while dirty prompts the guard — Keep editing stays, Discard closes', async ({
    page,
  }) => {
    const drawer = await openDrawer(page, 'Discovery & Design');
    await drawer.getByRole('textbox', { name: 'Task name' }).fill('Dirty name');

    await page.keyboard.press('Escape');
    const guard = page.getByRole('alertdialog', { name: 'Discard unsaved changes?' });
    await expect(guard).toBeVisible();

    // Keep editing keeps the drawer open with the edit intact.
    await guard.getByRole('button', { name: 'Keep editing' }).click();
    await expect(guard).toHaveCount(0);
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('textbox', { name: 'Task name' })).toHaveValue('Dirty name');

    // Discard drops the edit and closes.
    await page.keyboard.press('Escape');
    await expect(guard).toBeVisible();
    await guard.getByRole('button', { name: 'Discard changes' }).click();
    await expect(drawer).not.toBeVisible();
  });

  test('close button while dirty prompts the guard instead of silently saving', async ({ page }) => {
    const drawer = await openDrawer(page, 'Discovery & Design');
    await drawer.getByRole('textbox', { name: 'Task name' }).fill('Dirty name');
    await drawer.getByRole('button', { name: 'Close task detail' }).click();
    await expect(page.getByRole('alertdialog', { name: 'Discard unsaved changes?' })).toBeVisible();
  });

  test('Expand while dirty prompts the guard — Keep editing stays, Discard navigates to the full page', async ({
    page,
  }) => {
    const drawer = await openDrawer(page, 'Discovery & Design');
    await drawer.getByRole('textbox', { name: 'Task name' }).fill('Dirty name');
    const guard = page.getByRole('alertdialog', { name: 'Discard unsaved changes?' });

    // Keep editing stays on the drawer (does not navigate).
    await drawer.getByRole('button', { name: 'Expand to full page' }).click();
    await expect(guard).toBeVisible();
    await guard.getByRole('button', { name: 'Keep editing' }).click();
    await expect(guard).toHaveCount(0);
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('textbox', { name: 'Task name' })).toHaveValue('Dirty name');

    // Discard navigates to the full-page task view.
    await drawer.getByRole('button', { name: 'Expand to full page' }).click();
    await expect(guard).toBeVisible();
    await guard.getByRole('button', { name: 'Discard changes' }).click();
    await expect(page).toHaveURL(/\/tasks\/t1/);
  });

  test('Description renders Markdown formatting in read mode after editing (issue 1048)', async ({
    page,
  }) => {
    const drawer = await openDrawer(page, 'Discovery & Design');
    await drawer.getByRole('button', { name: 'Description' }).click();
    const description = drawer.getByRole('textbox', { name: 'Description' });
    await description.fill('**Bold AC** and\n\n- first item\n- second item\n\nUse `token`.');

    // Blur the editor by focusing the task-name input — returns the Description
    // to read mode (it no longer saves on blur; the draft is rendered as-is).
    await drawer.getByRole('textbox', { name: 'Task name' }).click();

    // Read mode now renders formatted Markdown (safe React nodes, not raw text).
    const readBlock = drawer.getByRole('button', { name: 'Description' });
    await expect(readBlock.locator('strong', { hasText: 'Bold AC' })).toBeVisible();
    await expect(readBlock.locator('li', { hasText: 'first item' })).toBeVisible();
    await expect(readBlock.locator('code', { hasText: 'token' })).toBeVisible();
    // The raw Markdown source is not shown verbatim in read mode.
    await expect(readBlock).not.toContainText('**Bold AC**');
  });
});

test.describe('TaskDetailDrawer redesign — chrome', () => {
  test.beforeEach(async ({ page }) => {
    await gotoSchedule(page);
  });

  test('Esc closes the drawer', async ({ page }) => {
    const drawer = await openDrawer(page, 'Discovery & Design');
    await page.keyboard.press('Escape');
    await expect(drawer).not.toBeVisible();
  });

  test('clicking the close button closes the drawer', async ({ page }) => {
    const drawer = await openDrawer(page, 'Discovery & Design');
    await drawer.getByRole('button', { name: 'Close task detail' }).click();
    await expect(drawer).not.toBeVisible();
  });
});

test.describe('TaskDetailDrawer — Viewer read-only (#1142/#1143, ADR-0133)', () => {
  test.beforeEach(async ({ page }) => {
    // A Viewer: server says can_edit=false AND role resolves to 0, so both the
    // capability field and the fallback agree on read-only.
    await gotoSchedule(page, { role: 0, canEdit: false });
  });

  test('shows the "View only" chip and gates the status control to static text', async ({
    page,
  }) => {
    const drawer = await openDrawer(page, 'Discovery & Design');

    // #1143: the explicit, unambiguous read-state indicator.
    await expect(drawer.getByText('View only')).toBeVisible();

    // #1142: the status control is hidden (Sarah's "client clicks the dropdown
    // and nothing happens" blocker) — no editable select, but the value remains.
    await expect(drawer.getByRole('combobox', { name: /Task status/i })).toHaveCount(0);
    await expect(drawer.getByText('In progress').first()).toBeVisible();

    // The task name is read-only, not an editable input.
    await expect(drawer.getByRole('textbox', { name: 'Task name' })).toHaveAttribute(
      'readonly',
      '',
    );
  });
});

test.describe('TaskDetailDrawer — editor sees controls (ADR-0133 contrast)', () => {
  test.beforeEach(async ({ page }) => {
    await gotoSchedule(page, { role: 300, canEdit: true });
  });

  test('an editor sees the status select and no "View only" chip', async ({ page }) => {
    const drawer = await openDrawer(page, 'Discovery & Design');
    await expect(drawer.getByText('View only')).toHaveCount(0);
    await expect(drawer.getByRole('combobox', { name: /Task status/i })).toBeVisible();
  });
});
