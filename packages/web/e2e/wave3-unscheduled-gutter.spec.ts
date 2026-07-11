import { test, expect } from '@playwright/test';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * E2E tests for wave 3 unscheduled gutter (#213):
 * - Gutter renders below the Gantt with count badge
 * - Task rows appear for NOT_STARTED tasks with no start date and no sprint (#317)
 * - Collapse / expand toggle persists
 * - "All tasks have planned dates" message when no unscheduled tasks
 * - Overflow menu → "Set planned start" → submit → PATCH sent with planned_start
 * - Esc dismisses overflow menu
 */

const FIXTURE_PROJECT_ID = 'e2e-fixture-00000000-0000-0000-0000-000000000001';

const FIXTURE_API_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Gutter Test Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

/** Mix of scheduled and unscheduled tasks. */
const FIXTURE_API_TASKS = [
  {
    id: 't1',
    wbs_path: '1',
    name: 'Design Sprint',
    early_start: '2026-04-07',
    early_finish: '2026-04-21',
    planned_start: null,
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
    // Unscheduled — early_start null, BACKLOG → start: '' in mapped Task
    id: 't2',
    wbs_path: '2',
    name: 'Parking Lot Item',
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
    // Second unscheduled
    id: 't3',
    wbs_path: '3',
    name: 'Future Feature',
    early_start: null,
    early_finish: null,
    planned_start: null,
    duration: 3,
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
];

const FIXTURE_API_TASKS_ALL_SCHEDULED = [
  {
    id: 't1',
    wbs_path: '1',
    name: 'Design Sprint',
    early_start: '2026-04-07',
    early_finish: '2026-04-21',
    planned_start: null,
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
];

async function setupRoutes(page: import('@playwright/test').Page, tasks = FIXTURE_API_TASKS) {
  await page.addInitScript(() => {
    // Clear any persisted collapsed state so tests start with gutter expanded
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
        task_count: tasks.length,
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
        total_tasks: tasks.length,
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
  await page.route('**/api/v1/tasks/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: tasks.length, next: null, previous: null, results: tasks }),
    }),
  );
  await page.route('**/api/v1/dependencies/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
}

async function gotoSchedule(page: import('@playwright/test').Page, tasks = FIXTURE_API_TASKS) {
  await setupRoutes(page, tasks);
  await page.goto(`/projects/${FIXTURE_PROJECT_ID}/schedule`);
  await expect(page.getByRole('grid', { name: 'Task list' })).toBeVisible({ timeout: 10_000 });
}

// 401-guard safety net, registered once before each test so it is the EARLIEST
// route and every specific mock (in setupRoutes and per-test overrides) wins over
// it by Playwright's most-recently-added precedence. Any endpoint not mocked
// elsewhere (the app-wide shell + ⌘K palette fetch programs, sprints, velocity,
// project detail, me/work, …) would otherwise 401 → refresh → expire and raise the
// full-screen session-expired modal, which then intercepts every click. This spec
// previously passed on timing slack that #647's extra app-wide hook subscriptions
// removed.
test.beforeEach(async ({ page }) => {
  // Shared 404 catch-all (issue 1513): unmocked endpoints 404 loudly instead of
  // being masked by a permissive 200-list body (the #1190 flake class).
  await setupCatchAll(page);
  await page.route('**/api/v1/auth/me/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'u1', email: 'pm@example.com', first_name: 'P', last_name: 'M' }),
    }),
  );
});

// ---------------------------------------------------------------------------
// Gutter header — count and empty state
// ---------------------------------------------------------------------------

test.describe('Unscheduled gutter — header (#213)', () => {
  test('shows correct unscheduled count', async ({ page }) => {
    await gotoSchedule(page);
    // 2 unscheduled tasks (t2, t3). exact:true targets the header-strip count
    // span, not the "To Do · Unscheduled (2)" section sub-header (#318 two-section
    // tray now renders the count in both places).
    await expect(page.getByText('(2)', { exact: true })).toBeVisible();
  });

  test('shows "All To Do and Backlog tasks have planned dates" when no unscheduled tasks', async ({
    page,
  }) => {
    await gotoSchedule(page, FIXTURE_API_TASKS_ALL_SCHEDULED);
    await expect(page.getByText('All To Do and Backlog tasks have planned dates')).toBeVisible();
  });

  test('shows "Unscheduled" section heading', async ({ page }) => {
    await gotoSchedule(page);
    // exact:true targets the header-strip label, not "To Do · Unscheduled (N)".
    await expect(page.getByText('Unscheduled', { exact: true })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Task rows in gutter
// ---------------------------------------------------------------------------

test.describe('Unscheduled gutter — task rows (#213)', () => {
  test.beforeEach(async ({ page }) => {
    await gotoSchedule(page);
  });

  test('unscheduled task names appear in gutter', async ({ page }) => {
    const gutter = page.getByRole('region', { name: 'Unscheduled tasks' });
    await expect(gutter.getByText('Parking Lot Item')).toBeVisible();
    await expect(gutter.getByText('Future Feature')).toBeVisible();
  });

  test('scheduled task does not appear in gutter', async ({ page }) => {
    // "Design Sprint" is scheduled (early_start set); should not be in gutter rows
    // The task name still appears in the task list panel — but there should be exactly
    // one instance (in the task list, not doubled in the gutter)
    const allMatches = page.getByText('Design Sprint', { exact: true });
    await expect(allMatches).toHaveCount(1);
  });

  test('task row shows duration', async ({ page }) => {
    const gutter = page.getByRole('region', { name: 'Unscheduled tasks' });
    await expect(gutter.getByText('5d')).toBeVisible();
    await expect(gutter.getByText('3d')).toBeVisible();
  });

  test('each row has an overflow actions button', async ({ page }) => {
    const actionsBtn = page.getByRole('button', { name: 'Actions for Parking Lot Item' });
    await expect(actionsBtn).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Collapse / expand
// ---------------------------------------------------------------------------

test.describe('Unscheduled gutter — collapse / expand (#213)', () => {
  test.beforeEach(async ({ page }) => {
    await gotoSchedule(page);
  });

  test('collapse button is present when there are unscheduled tasks', async ({ page }) => {
    const collapseBtn = page.getByRole('button', { name: /collapse unscheduled tasks/i });
    await expect(collapseBtn).toBeVisible();
  });

  test('clicking collapse hides task rows', async ({ page }) => {
    const gutter = page.getByRole('region', { name: 'Unscheduled tasks' });
    const collapseBtn = page.getByRole('button', { name: /collapse unscheduled tasks/i });
    await collapseBtn.click();
    await expect(gutter.getByText('Parking Lot Item')).not.toBeVisible();
  });

  test('clicking expand after collapse shows task rows again', async ({ page }) => {
    const gutter = page.getByRole('region', { name: 'Unscheduled tasks' });
    const collapseBtn = page.getByRole('button', { name: /collapse unscheduled tasks/i });
    await collapseBtn.click();
    const expandBtn = page.getByRole('button', { name: /expand unscheduled tasks/i });
    await expect(expandBtn).toBeVisible();
    await expandBtn.click();
    await expect(gutter.getByText('Parking Lot Item')).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Overflow menu — keyboard promote path
// ---------------------------------------------------------------------------

test.describe('Unscheduled gutter — overflow menu promote (#213)', () => {
  test.beforeEach(async ({ page }) => {
    await gotoSchedule(page);
  });

  test('overflow menu opens on button click', async ({ page }) => {
    await page.getByRole('button', { name: 'Actions for Parking Lot Item' }).click();
    await expect(page.getByText('Set planned start')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Promote to schedule' })).toBeVisible();
  });

  test('Promote to schedule button is disabled when no date entered', async ({ page }) => {
    await page.getByRole('button', { name: 'Actions for Parking Lot Item' }).click();
    const promoteBtn = page.getByRole('button', { name: 'Promote to schedule' });
    await expect(promoteBtn).toBeDisabled();
  });

  test('Esc closes overflow menu', async ({ page }) => {
    await page.getByRole('button', { name: 'Actions for Parking Lot Item' }).click();
    await expect(page.getByText('Set planned start')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByText('Set planned start')).not.toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Sprint-assigned backlog — grouped, read-only (#1790)
// ---------------------------------------------------------------------------

/** A sprint-assigned BACKLOG task: excluded from CPM (no early_start), so it
 *  strands at the project origin unless grouped into the gutter under its
 *  target sprint. */
const FIXTURE_SPRINT_BACKLOG_TASK = {
  id: 'sb1',
  wbs_path: '4',
  name: 'Contact dedupe',
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
  story_points: 5,
  sprint: 's3',
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
};

const FIXTURE_PLANNED_SPRINT = {
  id: 's3',
  server_version: 1,
  short_id: 'SP-S3',
  short_id_display: 'SP-S3',
  name: 'Build Sprint 3',
  goal: '',
  notes: '',
  start_date: '2026-07-17',
  finish_date: '2026-07-30',
  state: 'PLANNED',
  target_milestone: null,
  target_milestone_detail: null,
  committed_points: null,
  completed_points: null,
  capacity_points: 32,
};

test.describe('Unscheduled gutter — sprint-assigned backlog (#1790)', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/v1/projects/*/sprints/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          count: 1,
          next: null,
          previous: null,
          results: [FIXTURE_PLANNED_SPRINT],
        }),
      }),
    );
    await gotoSchedule(page, [...FIXTURE_API_TASKS, FIXTURE_SPRINT_BACKLOG_TASK]);
  });

  test('groups the backlog task under its target sprint with an honest, non-committal header', async ({
    page,
  }) => {
    const group = page.getByRole('group', {
      name: /Targeted for Build Sprint 3, planned, read-only/i,
    });
    await expect(group).toBeVisible();
    await expect(group.getByText('Contact dedupe')).toBeVisible();
    await expect(group.getByText('pending team plan — not scheduled')).toBeVisible();
  });

  test('the backlog row is READ-ONLY — no scheduling actions menu', async ({ page }) => {
    // The ··· "Actions for …" menu (drag/date scheduling) must not exist for a
    // sprint-committed backlog item — sprint sovereignty.
    await expect(page.getByRole('button', { name: 'Actions for Contact dedupe' })).toHaveCount(0);
    const group = page.getByRole('group', { name: /Targeted for Build Sprint 3/i });
    // exact:true so the lowercase "planned" label doesn't also match the
    // "· Planned" state word in the group header (Playwright text is substring
    // + case-insensitive by default).
    await expect(group.getByText('planned', { exact: true })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// "N planned" phase badge (#1798) — at-a-glance layer for #1790
// ---------------------------------------------------------------------------

/** A phase whose subtree holds sprint-assigned backlog: the badge summarizes it. */
const FIXTURE_PHASE = {
  id: 'ph5',
  wbs_path: '5',
  name: 'Data Migration',
  early_start: '2026-04-07',
  early_finish: '2026-04-21',
  planned_start: null,
  duration: 14,
  percent_complete: 0,
  is_critical: false,
  is_milestone: false,
  is_summary: true,
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
};

/** The phase's sprint-assigned backlog child (CPM-excluded, so undated). */
const FIXTURE_PHASE_BACKLOG_CHILD = {
  ...FIXTURE_SPRINT_BACKLOG_TASK,
  id: 'sb5',
  wbs_path: '5.1',
  name: 'Backfill emails',
  parent_id: 'ph5',
};

test.describe('Schedule — "N planned" phase badge (#1798)', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/v1/projects/*/sprints/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          count: 1,
          next: null,
          previous: null,
          results: [FIXTURE_PLANNED_SPRINT],
        }),
      }),
    );
    await gotoSchedule(page, [...FIXTURE_API_TASKS, FIXTURE_PHASE, FIXTURE_PHASE_BACKLOG_CHILD]);
  });

  test('renders a muted "N planned" badge on the phase row with an honest tooltip', async ({
    page,
  }) => {
    const badge = page.getByTestId('planned-badge');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText('1 planned');
    await expect(badge).toHaveAttribute(
      'title',
      'Planned for Build Sprint 3 — not a committed date',
    );
  });

  test('clicking the badge reveals the target sprint group in the collapsed tray', async ({
    page,
  }) => {
    const gutter = page.getByRole('region', { name: 'Unscheduled tasks' });
    // Collapse the tray so the reveal is observable.
    await page.getByRole('button', { name: /collapse unscheduled tasks/i }).click();
    await expect(gutter.getByText('Backfill emails')).not.toBeVisible();

    await page.getByTestId('planned-badge').click();

    // The badge expands the tray and brings the sprint group back into view.
    const group = gutter.getByRole('group', { name: /Targeted for Build Sprint 3/i });
    await expect(group).toBeVisible();
    await expect(group.getByText('Backfill emails')).toBeVisible();
  });
});

test.describe('Unscheduled gutter — promote sends PATCH (#213)', () => {
  test.beforeEach(async ({ page }) => {
    await gotoSchedule(page);
  });

  test('submitting a date sends PATCH with planned_start', async ({ page }) => {
    // Intercept the PATCH and record the request body
    let patchBody: Record<string, unknown> | null = null;
    await page.route('**/api/v1/tasks/t2/', async (route) => {
      if (route.request().method() === 'PATCH') {
        patchBody = (await route.request().postDataJSON()) as Record<string, unknown>;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: 't2',
            name: 'Parking Lot Item',
            project: FIXTURE_PROJECT_ID,
            wbs_path: '2',
            duration: 5,
            status: 'NOT_STARTED',
            percent_complete: 0,
          }),
        });
      } else {
        await route.continue();
      }
    });

    await page.getByRole('button', { name: 'Actions for Parking Lot Item' }).click();
    const dateInput = page.locator('input[type="date"]').first();
    await dateInput.fill('2026-05-12');
    await page.getByRole('button', { name: 'Promote to schedule' }).click();

    // Verify the PATCH was issued with the correct fields. The frontend now
    // sends only planned_start; the date-gated NOT_STARTED → IN_PROGRESS
    // transition is enforced server-side in TaskSerializer.update so it
    // applies uniformly across gutter promote, Gantt drag, drawer date edits,
    // and integration sync (#336). pytest covers the server-side branches
    // exhaustively; this E2E only confirms the wire shape.
    // Poll until the PATCH route handler has captured the body rather than
    // sleeping a fixed 500ms — the assertion runs the instant the request lands.
    await expect.poll(() => patchBody).not.toBeNull();
    expect(patchBody!['planned_start']).toBe('2026-05-12');
    expect(patchBody!['status']).toBeUndefined();
    expect(patchBody!['actual_start']).toBeUndefined();
  });
});
