/**
 * E2E for sync conflict hardening (ADR-0217, #322).
 *
 * Two PMs edit the same task. When their edits are disjoint the server merges
 * (200) and the edit lands silently. When they overlap the server returns 409 and
 * the loser sees the "Someone else changed this" toast with a Reload action — no
 * silent data loss. We drive one browser and mock the *other* PM's write as the
 * server response (200 merge / 409 conflict), which is the deterministic seam.
 */
import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

const FIXTURE_PROJECT_ID = 'e2e-322-00000000-0000-0000-0000-000000000322';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}`;

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Conflict Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

const TASK = {
  id: 't1',
  wbs_path: '1',
  name: 'Build feature',
  early_start: '2026-04-07',
  early_finish: '2026-04-14',
  planned_start: '2026-04-07',
  duration: 7,
  percent_complete: 30,
  is_critical: false,
  is_milestone: false,
  is_summary: false,
  parent_id: null,
  status: 'IN_PROGRESS',
  assignees: [],
  total_float: 5,
  predecessor_count: 0,
  is_blocked: false,
  linked_risks_count: 0,
  linked_risks_max_severity: null,
  readiness: 'ready',
  notes: 'Existing notes',
  server_version: 4,
};

/** Install every mock the board page reads, plus a per-test PATCH handler. */
async function setup(page: Page, patchHandler: (route: Route) => void): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });

  const tasks = [TASK];

  // The task PATCH — the write under test. Registered first so it wins over the
  // list-shaped '**/api/v1/tasks/**' catch below.
  await page.route(`**/api/v1/tasks/${TASK.id}/`, (route) => {
    if (route.request().method() === 'PATCH') {
      patchHandler(route);
      return;
    }
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(TASK),
    });
  });

  await page.route('**/api/v1/projects/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 1, next: null, previous: null, results: FIXTURE_PROJECTS }),
    }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/overview/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        schedule_health: 'unknown', spi: null, tasks_late_count: 0,
        critical_task_count: 0, total_tasks: 1, complete_tasks: 0,
        next_milestone: null, team_utilization_pct: null, owner_name: null,
        start_date: '2026-04-01',
      }),
    }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/attention/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/my-tasks/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tasks: [] }) }),
  );
  await page.route('**/api/v1/projects/*/presence/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  await page.route('**/api/v1/projects/*/workshop/current/', (route) =>
    route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ detail: 'No active workshop session.' }) }),
  );
  await page.route('**/api/v1/projects/*/status-summary/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        task_count: tasks.length, critical_path_count: 0, monte_carlo_p80: null,
        at_risk_count: 0, critical_count: 0, at_risk_tasks: [], critical_tasks: [],
        last_saved: null, recalculated_at: null,
      }),
    }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/sprints/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }) }),
  );
  await page.route('**/api/v1/tasks/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: tasks.length, next: null, previous: null, results: tasks }),
    }),
  );
  await page.route('**/api/v1/dependencies/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }) }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/risks/**`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }) }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/resource-allocation/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        project_id: FIXTURE_PROJECT_ID, window_start: '2026-04-01', window_end: '2026-05-30', resources: [],
      }),
    }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/board-views/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/board-config/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        columns: [
          { status: 'BACKLOG',     label: 'Backlog',     visible: true, wip_limit: null, color: '#94A3B8' },
          { status: 'NOT_STARTED', label: 'To Do',       visible: true, wip_limit: null, color: '#64748B' },
          { status: 'IN_PROGRESS', label: 'In Progress', visible: true, wip_limit: null, color: '#3B82F6' },
          { status: 'REVIEW',      label: 'Review',      visible: true, wip_limit: null, color: '#A855F7' },
          { status: 'COMPLETE',    label: 'Done',        visible: true, wip_limit: null, color: '#22C55E' },
        ],
      }),
    }),
  );
}

/** Open the task's edit modal via its card Actions menu → Edit. */
async function openEditModal(page: Page) {
  await page.goto(`${BASE_URL}/board`);
  // Gate on the card being rendered (board reads resolved) before touching chrome.
  const actions = page.getByRole('button', { name: `Actions for ${TASK.name}` });
  await expect(actions).toBeVisible({ timeout: 10_000 });
  await actions.click();
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  const dialog = page.getByRole('dialog', { name: /Build feature/ });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe('Sync conflict — field-level merge (#322)', () => {
  test('overlapping edit surfaces the conflict toast with a Reload action', async ({ page }) => {
    await setup(page, (route) =>
      route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'sync_conflict',
          detail: 'Someone else changed this. Reload to see their changes.',
          conflict_fields: ['name'],
          server_value: { name: 'Their edit' },
          client_value: { name: 'My edit' },
          server_version: 6,
        }),
      }),
    );
    const dialog = await openEditModal(page);
    await dialog.getByLabel(/Task name/).fill('My edit');
    await dialog.getByRole('button', { name: /Save/ }).click();

    // The loser sees the conflict toast + Reload affordance — no silent loss.
    await expect(page.getByText('Someone else changed this. Reload to see their changes.')).toBeVisible();
    await expect(page.getByRole('button', { name: /Reload/ })).toBeVisible();
  });

  test('disjoint edit merges (200) and closes the modal with no error', async ({ page }) => {
    await setup(page, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'X-Merged-Concurrent-Fields': 'status' },
        body: JSON.stringify({ ...TASK, name: 'My edit', server_version: 6 }),
      }),
    );
    const dialog = await openEditModal(page);
    await dialog.getByLabel(/Task name/).fill('My edit');
    await dialog.getByRole('button', { name: /Save/ }).click();

    // Merge succeeded: the dialog closes and no conflict toast appears.
    await expect(dialog).toBeHidden();
    await expect(page.getByText(/Someone else changed this/)).toHaveCount(0);
  });
});
