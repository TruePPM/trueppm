/**
 * Board view E2E — phase swimlanes, LaneMeta, per-phase add task (issue #208 #211).
 */
import { test, expect } from '@playwright/test';

const FIXTURE_PROJECT_ID = 'e2e-board-00000000-0000-0000-0000-000000000010';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}`;

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Board Test Project',
    description: '',
    start_date: '2026-01-01',
    calendar: 'default',
  },
];

const FIXTURE_TASKS = [
  {
    id: 'b1', wbs_path: '1', name: 'Alpha Phase',
    early_start: '2026-01-05', early_finish: '2026-02-14',
    duration: 30, percent_complete: 55, is_critical: false,
    is_milestone: false, is_summary: true, parent_id: null,
    status: 'IN_PROGRESS', assignees: [], total_float: null,
    predecessor_count: 0, is_blocked: false,
    linked_risks_count: 0, linked_risks_max_severity: null,
  },
  {
    id: 'b2', wbs_path: '1.1', name: 'Design',
    early_start: '2026-01-05', early_finish: '2026-01-16',
    duration: 10, percent_complete: 100, is_critical: false,
    is_milestone: false, is_summary: false, parent_id: 'b1',
    status: 'COMPLETE', assignees: [], total_float: null,
    predecessor_count: 0, is_blocked: false,
    linked_risks_count: 0, linked_risks_max_severity: null,
  },
  {
    id: 'b3', wbs_path: '1.2', name: 'Build',
    early_start: '2026-01-19', early_finish: '2026-01-30',
    duration: 10, percent_complete: 60, is_critical: false,
    is_milestone: false, is_summary: false, parent_id: 'b1',
    status: 'IN_PROGRESS', assignees: [], total_float: null,
    // b3 PPM signals: 2 predecessors (one not complete) → blocked + 1 risk severity 18.
    predecessor_count: 2, is_blocked: true,
    linked_risks_count: 1, linked_risks_max_severity: 18,
  },
];

async function setup(page: import('@playwright/test').Page) {
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
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/overview/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ schedule_health: 'unknown', spi: null, tasks_late_count: 0, critical_task_count: 0, total_tasks: 0, complete_tasks: 0, next_milestone: null, team_utilization_pct: null }),
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
  await page.route('**/api/v1/projects/*/status-summary/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        task_count: 3,
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
  await page.route('**/api/v1/tasks/**', (route) => {
    if (route.request().method() === 'POST') {
      route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'b-new', wbs_path: '1.3', name: 'New Task',
          early_start: '2026-02-01', early_finish: '2026-02-06',
          duration: 5, percent_complete: 0, is_critical: false,
          is_milestone: false, is_summary: false, parent_id: 'b1',
          status: 'NOT_STARTED', assignees: [],
        }),
      });
    } else {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: FIXTURE_TASKS.length, next: null, previous: null, results: FIXTURE_TASKS }),
      });
    }
  });
  await page.route('**/api/v1/dependencies/**', (route) => {
    const url = route.request().url();
    if (url.includes('task=b3')) {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          count: 2,
          next: null,
          previous: null,
          results: [
            { id: 'd1', predecessor: 'b2', successor: 'b3', dep_type: 'FS', lag: 0 },
            { id: 'd2', predecessor: 'b3', successor: 'b1', dep_type: 'FS', lag: 0 },
          ],
        }),
      });
      return;
    }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }) });
  });
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/risks/**`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }) }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/resource-allocation/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        project_id: FIXTURE_PROJECT_ID,
        window_start: '2026-01-01',
        window_end: '2026-03-01',
        resources: [],
      }),
    }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/board-config/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        columns: [
          { status: 'BACKLOG',     label: 'Backlog',     visible: true },
          { status: 'NOT_STARTED', label: 'To Do',       visible: true },
          { status: 'IN_PROGRESS', label: 'In Progress', visible: true },
          { status: 'REVIEW',      label: 'Review',      visible: true },
          { status: 'COMPLETE',    label: 'Done',        visible: true },
        ],
      }),
    }),
  );
}

test.describe('Board view', () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
    await page.goto(`${BASE_URL}/board`);
    // Wait for the board grid's sticky column header to confirm the board is ready.
    // Column header text comes from board-config, not from task data — it always
    // appears once the board renders (even if phase lanes are still loading).
    await expect(page.getByText('In Progress')).toBeVisible({ timeout: 10_000 });
    // Then wait for the phase lane to confirm tasks have loaded.
    await expect(page.getByText('Alpha Phase')).toBeVisible({ timeout: 10_000 });
  });

  test('renders LaneMeta with phase name, progress %, and task count', async ({ page }) => {
    await expect(page.getByText('Alpha Phase')).toBeVisible();
    // Average is computed from leaf tasks: (100 + 60) / 2 = 80%
    await expect(page.getByText('80%')).toBeVisible();
    await expect(page.getByText('2 tasks')).toBeVisible();
  });

  test('per-phase + button opens AddTaskModal with phase pre-selected (issue #208)', async ({ page }) => {
    const addBtn = page.getByRole('button', { name: /Add task to Alpha Phase/ });
    await expect(addBtn).toBeVisible();
    await addBtn.click();

    const dialog = page.getByRole('dialog', { name: /Add task to Alpha Phase/ });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Alpha Phase')).toBeVisible();
    await expect(dialog.getByRole('textbox')).toBeVisible();
  });

  test('AddTaskModal submits and closes on save', async ({ page }) => {
    await page.getByRole('button', { name: /Add task to Alpha Phase/ }).click();
    const dialog = page.getByRole('dialog', { name: /Add task to Alpha Phase/ });
    await dialog.getByRole('textbox').fill('My new task');
    await dialog.getByRole('button', { name: 'Add task' }).click();
    await expect(dialog).not.toBeVisible({ timeout: 5_000 });
  });

  test('AddTaskModal closes on Cancel', async ({ page }) => {
    await page.getByRole('button', { name: /Add task to Alpha Phase/ }).click();
    const dialog = page.getByRole('dialog', { name: /Add task to Alpha Phase/ });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).not.toBeVisible();
  });

  test('AddTaskModal closes on Escape', async ({ page }) => {
    await page.getByRole('button', { name: /Add task to Alpha Phase/ }).click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).not.toBeVisible();
  });

  test('column headers render (issue #211)', async ({ page }) => {
    await expect(page.getByText('Backlog')).toBeVisible();
    await expect(page.getByText('To Do')).toBeVisible();
    await expect(page.getByText('In Progress')).toBeVisible();
    await expect(page.getByText('Review')).toBeVisible();
    await expect(page.getByText('Done')).toBeVisible();
  });

  test('column tints toggle is visible and on by default (issue #211)', async ({ page }) => {
    const toggle = page.getByLabel('Show column tints');
    await expect(toggle).toBeVisible();
    await expect(toggle).toBeChecked();
  });

  // -------------------------------------------------------------------------
  // Board batch 3 — PPM signals on cards (issues #182 #184 #187 #188 #195).
  // -------------------------------------------------------------------------

  test('blocked dependency icon renders on Build card (issue #182)', async ({ page }) => {
    await expect(page.getByLabel(/Blocked by 2 dependencies\. Press D to view\./)).toBeVisible();
  });

  test('risk linkage icon renders with severity-aware aria-label (issue #188)', async ({ page }) => {
    await expect(page.getByLabel(/1 linked risk, severity red\. Click to view\./)).toBeVisible();
  });

  test('? opens the keyboard cheatsheet and Esc closes it (issue #195)', async ({ page }) => {
    await page.keyboard.press('?');
    const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Next card in column')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
  });

  test('Risk-linked-only filter pill toggles aria-pressed (issue #188)', async ({ page }) => {
    const pill = page.getByRole('button', { name: 'Risk-linked only' });
    await expect(pill).toHaveAttribute('aria-pressed', 'false');
    await pill.click();
    await expect(pill).toHaveAttribute('aria-pressed', 'true');
  });

  test('clicking the chain icon opens the dependency popover with both directions (issue #182)', async ({ page }) => {
    await page.getByLabel(/Blocked by 2 dependencies\. Press D to view\./).click();
    const dialog = page.getByRole('dialog', { name: 'Dependencies' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/Predecessors \(1\)/)).toBeVisible();
    await expect(dialog.getByText(/Successors \(1\)/)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
  });
});
