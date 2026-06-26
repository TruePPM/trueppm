/**
 * Wave 10 — Sprints view backlog table E2E (issue #229).
 *
 * Verifies that the active sprint's tasks render below the cadence strip,
 * grouped by board status with CP flags and the open-in-board link wired.
 */
import { test, expect } from '@playwright/test';

const PROJECT_ID = 'e2e-sprints-backlog-00000000-0000-0000-0000-000000000030';
const BASE_URL = `/projects/${PROJECT_ID}/sprints`;

const FIXTURE_PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Sprints Backlog Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
    methodology: 'AGILE',
  },
];

const PROJECT_DETAIL = {
  id: PROJECT_ID,
  server_version: 1,
  name: 'Sprints Backlog Project',
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

const BACKLOG_TASKS = [
  { id: 'task-1', short_id: 'A1', name: 'Calibrate sensors', wbs_path: '1.1', status: 'IN_PROGRESS', story_points: 5, is_critical: true, assignments: [{ resource_id: 'r1', resource_name: 'Aisha Khan', units: 1 }] },
  { id: 'task-2', short_id: 'A2', name: 'Wire telemetry channel', wbs_path: '1.2', status: 'IN_PROGRESS', story_points: 8, is_critical: false, assignments: [{ resource_id: 'r2', resource_name: 'Ben Lee', units: 1 }] },
  { id: 'task-3', short_id: 'A3', name: 'Draft FAT report', wbs_path: '1.3', status: 'BACKLOG', story_points: 3, is_critical: false, assignments: [] },
  { id: 'task-4', short_id: 'A4', name: 'Power supply review', wbs_path: '1.4', status: 'COMPLETE', story_points: 2, is_critical: false, assignments: [{ resource_id: 'r1', resource_name: 'Aisha Khan', units: 0.5 }] },
];

// The full-Task project list (GET /tasks/?project=) that feeds useScheduleTasks.
// SprintsView resolves a clicked backlog row to one of these to open the shared
// TaskDetailDrawer, so every backlog id above must also appear here in full.
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
  };
}
const FULL_TASKS = BACKLOG_TASKS.map(fullTaskShape);

async function setupCommon(page: import('@playwright/test').Page) {
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
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 1, next: null, previous: null, results: FIXTURE_PROJECTS }),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PROJECT_DETAIL) }),
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
          committed_hours: 0, available_hours: 0, ratio: 0, buffer_hours: 0,
          label: 'on_track', pto_days: 0,
        },
        working_days: 0, hours_per_day: 8,
      }),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/velocity/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sprints: [],
        rolling_avg_points: null, rolling_stdev_points: null,
        forecast_range_low: null, forecast_range_high: null,
        rolling_avg_tasks: null, rolling_stdev_tasks: null,
      }),
    }),
  );
  // Register the catch-all FIRST; Playwright's last-registered-wins semantics
  // means the specific matches below take precedence.
  await page.route(/\/api\/v1\/tasks\//, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
  // Full project task list (project= only, no sprint=) → the useScheduleTasks
  // source the detail drawer reads. The `$` anchor keeps this from also matching
  // the project=&sprint= backlog URL below.
  await page.route(/\/api\/v1\/tasks\/\?project=[^&]+$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: FULL_TASKS.length, next: null, previous: null, results: FULL_TASKS }),
    }),
  );
  // Specific match — sprint-filtered task list returns the populated backlog.
  await page.route(/\/api\/v1\/tasks\/.*sprint=sp-active/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: BACKLOG_TASKS.length, next: null, previous: null, results: BACKLOG_TASKS }),
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
        task_count: 0, critical_path_count: 0, monte_carlo_p80: null,
        at_risk_count: 0, critical_count: 0, at_risk_tasks: [], critical_tasks: [],
        last_saved: null, recalculated_at: null,
      }),
    }),
  );
  await page.route('**/api/v1/edition/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ edition: 'community' }) }),
  );
  await page.route('**/api/v1/auth/me/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'e2e-user', username: 'e2e', display_name: 'E2E', initials: 'E', email: 'e2e@example.com' }),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'mem-1', role: 300 }]) }),
  );
  await page.route(/\/api\/v1\/sprints\/.*\/retro\//, (route) =>
    route.fulfill({ status: 404, contentType: 'application/json', body: '{"detail":"None"}' }),
  );
  await page.route('**/api/v1/me/active-sprints/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
}

test.describe('Wave 10 — Sprints backlog table', () => {
  test('renders grouped tasks with CP flags and open-in-board link', async ({ page }) => {
    await setupCommon(page);
    await page.goto(BASE_URL);

    const backlog = page.getByRole('region', { name: /Sprint Backlog/i });
    await expect(backlog).toBeVisible();
    await expect(backlog.getByText('Calibrate sensors')).toBeVisible();
    await expect(backlog.getByText('Wire telemetry channel')).toBeVisible();
    await expect(backlog.getByText('Draft FAT report')).toBeVisible();
    await expect(backlog.getByText('Power supply review')).toBeVisible();

    // CP flag visible only on the critical task
    const cpFlags = backlog.getByLabel(/Critical path task/i);
    await expect(cpFlags).toHaveCount(1);

    // Open-in-board link
    const link = backlog.getByRole('link', { name: /Open in board/i });
    await expect(link).toHaveAttribute('href', `/projects/${PROJECT_ID}/board?sprint=sp-active`);
  });

  test('clicking a backlog task name opens the task detail drawer', async ({ page }) => {
    await setupCommon(page);
    await page.goto(BASE_URL);

    const backlog = page.getByRole('region', { name: /Sprint Backlog/i });
    await expect(backlog.getByText('Calibrate sensors')).toBeVisible();

    // The task name is an accessible "Open …" button, not static text.
    const openBtn = backlog.getByRole('button', { name: /Open Calibrate sensors/i });
    await expect(openBtn).toBeVisible();
    await openBtn.click();

    // The shared TaskDetailDrawer (role="dialog", aria-label = WBS — name) opens
    // with the clicked task, so the row is now editable.
    const drawer = page.getByRole('dialog', { name: /Calibrate sensors/i });
    await expect(drawer).toBeVisible();
  });

  test('group toggle hides rows and re-shows on second click', async ({ page }) => {
    await setupCommon(page);
    await page.goto(BASE_URL);

    const backlog = page.getByRole('region', { name: /Sprint Backlog/i });
    await expect(backlog.getByText('Calibrate sensors')).toBeVisible();

    const toggle = backlog.getByRole('button', { name: /In Progress/i });
    await toggle.click();
    await expect(backlog.getByText('Calibrate sensors')).not.toBeVisible();
    await toggle.click();
    await expect(backlog.getByText('Calibrate sensors')).toBeVisible();
  });
});
