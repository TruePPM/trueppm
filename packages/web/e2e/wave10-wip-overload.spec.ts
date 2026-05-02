/**
 * Wave 10 — WIP-limit overload detection E2E (issue #232).
 *
 * Verifies the at-limit and over-limit chips render on the board column
 * headers, and that moving a task into a column over its WIP limit triggers
 * the confirm prompt.
 */
import { test, expect } from '@playwright/test';

const PROJECT_ID = 'e2e-wip-00000000-0000-0000-0000-000000000070';
const BASE_URL = `/projects/${PROJECT_ID}/board`;

const FIXTURE_PROJECTS = [
  { id: PROJECT_ID, name: 'WIP Project', description: '', start_date: '2026-04-01', calendar: 'default', methodology: 'HYBRID' },
];

const FIXTURE_TASKS = [
  // Summary phase
  {
    id: 'phase-1', wbs_path: '1', name: 'Phase 1',
    early_start: '2026-04-01', early_finish: '2026-04-30',
    duration: 30, percent_complete: 0, is_critical: false,
    is_milestone: false, is_summary: true, parent_id: null,
    status: 'IN_PROGRESS', assignees: [], total_float: null,
    predecessor_count: 0, is_blocked: false,
    linked_risks_count: 0, linked_risks_max_severity: null,
    server_version: 1,
  },
  // Two leaves in IN_PROGRESS — wip_limit will be set to 1, so the column
  // is over-limit on initial load (count=2, limit=1).
  {
    id: 'task-a', wbs_path: '1.1', name: 'Wire telemetry',
    early_start: '2026-04-01', early_finish: '2026-04-05',
    duration: 5, percent_complete: 50, is_critical: false,
    is_milestone: false, is_summary: false, parent_id: 'phase-1',
    status: 'IN_PROGRESS', assignees: [], total_float: null,
    predecessor_count: 0, is_blocked: false,
    linked_risks_count: 0, linked_risks_max_severity: null,
    server_version: 1,
  },
  {
    id: 'task-b', wbs_path: '1.2', name: 'Calibrate sensors',
    early_start: '2026-04-06', early_finish: '2026-04-10',
    duration: 5, percent_complete: 25, is_critical: false,
    is_milestone: false, is_summary: false, parent_id: 'phase-1',
    status: 'IN_PROGRESS', assignees: [], total_float: null,
    predecessor_count: 0, is_blocked: false,
    linked_risks_count: 0, linked_risks_max_severity: null,
    server_version: 1,
  },
  // One BACKLOG task to drag/move into IN_PROGRESS.
  {
    id: 'task-c', wbs_path: '1.3', name: 'Draft FAT plan',
    early_start: '2026-04-11', early_finish: '2026-04-15',
    duration: 5, percent_complete: 0, is_critical: false,
    is_milestone: false, is_summary: false, parent_id: 'phase-1',
    status: 'BACKLOG', assignees: [], total_float: null,
    predecessor_count: 0, is_blocked: false,
    linked_risks_count: 0, linked_risks_max_severity: null,
    server_version: 1,
  },
];

const BOARD_CONFIG = {
  columns: [
    { status: 'BACKLOG',     label: 'Backlog',     visible: true, wip_limit: null, color: '#94A3B8' },
    { status: 'NOT_STARTED', label: 'To Do',       visible: true, wip_limit: null, color: '#64748B' },
    { status: 'IN_PROGRESS', label: 'In Progress', visible: true, wip_limit: 1,    color: '#3B82F6' },
    { status: 'REVIEW',      label: 'Review',      visible: true, wip_limit: null, color: '#A855F7' },
    { status: 'COMPLETE',    label: 'Done',        visible: true, wip_limit: null, color: '#22C55E' },
  ],
};

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
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 1, next: null, previous: null, results: FIXTURE_PROJECTS }) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...FIXTURE_PROJECTS[0], server_version: 1, calendar: null, estimation_mode: 'open', agile_features: false }) }),
  );
  await page.route(/\/api\/v1\/tasks\//, (route) => {
    if (route.request().method() === 'PATCH') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'task-c', status: 'IN_PROGRESS' }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: FIXTURE_TASKS.length, next: null, previous: null, results: FIXTURE_TASKS }) });
  });
  await page.route('**/api/v1/calendars/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }) }),
  );
  await page.route('**/api/v1/dependencies/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/board-config/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(BOARD_CONFIG) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/board-views/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  await page.route('**/api/v1/projects/*/presence/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  await page.route('**/api/v1/projects/*/status-summary/', (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        task_count: FIXTURE_TASKS.length, critical_path_count: 0, monte_carlo_p80: null,
        at_risk_count: 0, critical_count: 0, at_risk_tasks: [], critical_tasks: [],
        last_saved: null, recalculated_at: null,
      }),
    }),
  );
  await page.route('**/api/v1/edition/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ edition: 'community' }) }),
  );
  await page.route('**/api/v1/auth/me/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'e2e-user', username: 'e2e', display_name: 'E2E', initials: 'E', email: 'e2e@example.com' }) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'mem-1', role: 3 }]) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/risks/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/resource-allocation/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ resources: [], window_start: '2026-04-01', window_end: '2026-04-30', unassigned_task_count: 0 }),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/overview/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ schedule_health: 'unknown', spi: null, tasks_late_count: 0, critical_task_count: 0, total_tasks: FIXTURE_TASKS.length, complete_tasks: 0, next_milestone: null, team_utilization_pct: null, owner_name: null, start_date: '2026-04-01' }) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/attention/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/my-tasks/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tasks: [] }) }),
  );
  await page.route('**/api/v1/projects/*/workshop/current/', (route) =>
    route.fulfill({ status: 404, contentType: 'application/json', body: '{"detail":"None"}' }),
  );
  await page.route('**/api/v1/sprints/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }) }),
  );
  await page.route('**/api/v1/me/active-sprints/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
}

test.describe('Wave 10 — WIP-limit overload detection', () => {
  test('renders the over-limit chip on a column whose count exceeds its WIP limit', async ({ page }) => {
    await setupCommon(page);
    await page.goto(BASE_URL);
    // Wait for the board to leave its loading state — TanStack Query needs
    // a tick after the route mocks resolve before the columns paint.
    await expect(page.getByText(/Loading board/i)).toHaveCount(0, { timeout: 15_000 });
    // IN_PROGRESS has 2 leaves and wip_limit=1 → over-limit chip.
    await expect(page.getByLabel(/2 of 1 WIP limit, over limit/i)).toBeVisible();
    await expect(page.getByText(/2\/1 — over WIP limit/i)).toBeVisible();
  });

  test('move-to triggers a confirm prompt and cancels when user declines', async ({ page }) => {
    await setupCommon(page);
    let dialogShown = false;
    page.on('dialog', async (dlg) => {
      dialogShown = true;
      expect(dlg.message()).toMatch(/at its WIP limit/i);
      await dlg.dismiss();
    });

    let patchCalled = false;
    await page.route('**/api/v1/tasks/task-c/', (route) => {
      if (route.request().method() === 'PATCH') {
        patchCalled = true;
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'task-c', status: 'IN_PROGRESS' }) });
      }
      return route.continue();
    });

    await page.goto(BASE_URL);

    // Open the BACKLOG card's overflow menu and try to move it to IN PROGRESS.
    const trigger = page.getByLabel(/Actions for Draft FAT plan/i);
    await trigger.click();
    await page.getByRole('menuitem', { name: /^Move to/i }).click();
    await page.getByRole('menuitem', { name: /In Progress/i }).click();

    // Give the page a tick for any async path (no PATCH should fire on dismiss).
    await page.waitForTimeout(150);
    expect(dialogShown).toBe(true);
    expect(patchCalled).toBe(false);
  });
});
