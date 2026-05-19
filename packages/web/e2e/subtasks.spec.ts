import { test, expect, type Page } from '@playwright/test';

/**
 * E2E coverage for the Subtasks drawer section (ADR-0060 #308).
 *
 * All API calls are intercepted with Playwright route mocking — no backend
 * required. Covers the golden path (create subtask, progress rollup) plus
 * the depth-1 guard (disabled state for subtask-of-subtask).
 */

const PROJECT_ID = 'e2e-subtasks-00000000-0000-0000-0000-000000000001';

const FIXTURE_PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Subtask Test Project',
    description: '',
    start_date: '2026-01-01',
    calendar: 'default',
    estimation_mode: 'open',
  },
];

// Parent task — no subtasks initially.
const PARENT_TASK = {
  id: 'parent-t1',
  wbs_path: '1',
  name: 'Implement feature',
  early_start: '2026-04-01',
  early_finish: '2026-04-10',
  planned_start: null,
  duration: 7,
  percent_complete: 0,
  is_critical: false,
  is_milestone: false,
  is_summary: false,
  is_subtask: false,
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
  sprint_scope_changes: [],
  notes: '',
  assignments: [],
};

// Subtask row (already existing — for the populated state tests).
const SUBTASK_IN_PROGRESS = {
  ...PARENT_TASK,
  id: 'sub-t1',
  wbs_path: '1.1',
  name: 'Write unit tests',
  is_subtask: true,
  is_summary: false,
  parent_id: 'parent-t1',
  percent_complete: 50,
  status: 'IN_PROGRESS',
};

const SUBTASK_COMPLETE = {
  ...PARENT_TASK,
  id: 'sub-t2',
  wbs_path: '1.2',
  name: 'Write documentation',
  is_subtask: true,
  is_summary: false,
  parent_id: 'parent-t1',
  percent_complete: 100,
  status: 'COMPLETE',
};

// A task flagged is_subtask:true — depth-1 guard test.
// parent_id is null so it appears in the WBS tree root and the task list grid.
const SUBTASK_TASK = {
  ...PARENT_TASK,
  id: 'subtask-only',
  wbs_path: '2',
  name: 'A leaf subtask',
  is_subtask: true,
  parent_id: null,
};

async function setupRoutes(page: Page, tasks: object[]) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });

  // Catch-all: any /api/v1/ request not matched below returns 404 instead of
  // hitting the real Docker backend (which would 401, triggering session expiry).
  // Registered first so specific mocks (registered later) take precedence —
  // Playwright matches routes in LIFO order.
  await page.route('**/api/v1/**', (route) =>
    route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ detail: 'not mocked' }) }),
  );

  await page.route('**/api/v1/auth/me/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'e2e-user', username: 'e2euser', display_name: 'E2E User' }),
    }),
  );
  await page.route('**/api/v1/projects/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 1, next: null, previous: null, results: FIXTURE_PROJECTS }),
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
  await page.route(`**/api/v1/projects/${PROJECT_ID}/overview/`, (route) =>
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
  await page.route(`**/api/v1/projects/${PROJECT_ID}/attention/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/my-tasks/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tasks: [] }) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'mem-e2e', role: 300, user_id: 'e2e-user' }),
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
  await page.route('**/api/v1/sprints/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
}

async function openDrawer(page: Page, taskName: string) {
  await page.goto(`/projects/${PROJECT_ID}/schedule`);
  const grid = page.getByRole('grid', { name: 'Task list' });
  await expect(grid).toBeVisible({ timeout: 10_000 });
  await grid.getByText(taskName, { exact: true }).click();
  const drawer = page.getByRole('dialog', { name: new RegExp(taskName) }).first();
  await expect(drawer).toBeVisible({ timeout: 5_000 });
  return drawer;
}

test.describe('Subtasks drawer section', () => {
  test('Subtasks section appears in drawer for a regular task', async ({ page }) => {
    await setupRoutes(page, [PARENT_TASK]);
    const drawer = await openDrawer(page, 'Implement feature');
    await expect(drawer.getByRole('button', { name: 'Subtasks' })).toBeVisible();
  });

  test('shows empty-state when task has no subtasks', async ({ page }) => {
    await setupRoutes(page, [PARENT_TASK]);
    const drawer = await openDrawer(page, 'Implement feature');
    await drawer.getByRole('button', { name: 'Subtasks' }).click();
    await expect(drawer.getByText(/No subtasks yet/i)).toBeVisible({ timeout: 5_000 });
  });

  test('Add subtask button opens inline form', async ({ page }) => {
    await setupRoutes(page, [PARENT_TASK]);
    const drawer = await openDrawer(page, 'Implement feature');
    await drawer.getByRole('button', { name: 'Subtasks' }).click();
    await drawer.getByRole('button', { name: /add subtask/i }).click();
    await expect(drawer.getByRole('textbox', { name: /new subtask name/i })).toBeVisible({ timeout: 3_000 });
  });

  test('cancel button dismisses inline form', async ({ page }) => {
    await setupRoutes(page, [PARENT_TASK]);
    const drawer = await openDrawer(page, 'Implement feature');
    await drawer.getByRole('button', { name: 'Subtasks' }).click();
    await drawer.getByRole('button', { name: /add subtask/i }).click();
    await drawer.getByRole('button', { name: /cancel adding subtask/i }).click();
    await expect(drawer.getByRole('textbox', { name: /new subtask name/i })).not.toBeVisible();
  });

  test('renders existing subtasks with progress rollup bar', async ({ page }) => {
    await setupRoutes(page, [PARENT_TASK, SUBTASK_IN_PROGRESS, SUBTASK_COMPLETE]);
    const drawer = await openDrawer(page, 'Implement feature');
    await drawer.getByRole('button', { name: 'Subtasks' }).click();

    // Both subtask names appear.
    await expect(drawer.getByText('Write unit tests')).toBeVisible({ timeout: 5_000 });
    await expect(drawer.getByText('Write documentation')).toBeVisible();

    // Progress bar is present.
    await expect(drawer.getByRole('progressbar', { name: /subtask completion/i })).toBeVisible();

    // Completion count badge shows "1/2".
    await expect(drawer.getByText('1/2')).toBeVisible();
  });

  test('shows depth-1 guard message for subtask-of-subtask', async ({ page }) => {
    await setupRoutes(page, [SUBTASK_TASK]);
    const drawer = await openDrawer(page, 'A leaf subtask');
    await drawer.getByRole('button', { name: 'Subtasks' }).click();
    await expect(drawer.getByText(/cannot be nested/i)).toBeVisible({ timeout: 5_000 });
    await expect(drawer.getByRole('button', { name: /add subtask/i })).not.toBeVisible();
  });
});
