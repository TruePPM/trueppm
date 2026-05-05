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
  {
    id: 'b4', wbs_path: '1.3', name: 'Release',
    early_start: '2026-02-01', early_finish: '2026-02-05',
    duration: 5, percent_complete: 0, is_critical: false,
    is_milestone: true, is_summary: false, parent_id: 'b1',
    status: 'NOT_STARTED', assignees: [],
    total_float: null, predecessor_count: 0, is_blocked: false,
    linked_risks_count: 0, linked_risks_max_severity: null,
    status_changed_at: '2025-11-01T00:00:00Z',
    priority_rank: 3,
  },
  {
    id: 'b5', wbs_path: '1.4', name: 'QA Gate',
    early_start: '2026-01-05', early_finish: '2026-01-20',
    // PM-committed `planned_start` so the card renders scheduled-state UI
    // (float chip, baseline variance chip, SPI chip) under the #332
    // `isTaskScheduled` gate. Without it the card would be treated as
    // uncommitted backlog work and these chips would be suppressed.
    planned_start: '2026-01-05',
    duration: 12, percent_complete: 40, is_critical: false,
    is_milestone: false, is_summary: false, parent_id: 'b1',
    status: 'IN_PROGRESS', assignees: [],
    total_float: -3,
    predecessor_count: 0, is_blocked: false,
    linked_risks_count: 0, linked_risks_max_severity: null,
    status_changed_at: '2025-11-15T00:00:00Z',
    priority_rank: 1,
    baseline_start: '2026-01-01', baseline_finish: '2026-01-10',
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
      body: JSON.stringify({ schedule_health: 'unknown', spi: null, tasks_late_count: 0, critical_task_count: 0, total_tasks: 0, complete_tasks: 0, next_milestone: null, team_utilization_pct: null, owner_name: null, start_date: '2026-01-01' }),
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
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/board-views/`, (route) => {
    if (route.request().method() === 'GET') {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
      return;
    }
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as { name: string; config: unknown };
      route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'sv-e2e-1',
          name: body.name,
          config: body.config,
          created_by: 'e2e-user',
          server_version: 1,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        }),
      });
      return;
    }
    route.continue();
  });
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/board-config/`, (route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as { columns: unknown[] };
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ columns: body.columns }),
      });
      return;
    }
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        columns: [
          { status: 'BACKLOG',     label: 'Backlog',     visible: true, wip_limit: null, color: '#94A3B8' },
          { status: 'NOT_STARTED', label: 'To Do',       visible: true, wip_limit: null, color: '#64748B' },
          { status: 'IN_PROGRESS', label: 'In Progress', visible: true, wip_limit: 5,    color: '#3B82F6' },
          { status: 'REVIEW',      label: 'Review',      visible: true, wip_limit: 3,    color: '#A855F7' },
          { status: 'COMPLETE',    label: 'Done',        visible: true, wip_limit: null, color: '#22C55E' },
        ],
      }),
    });
  });
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
    // Average is computed from all leaf tasks: (100 + 60 + 0 + 40) / 4 = 50%
    await expect(page.getByText('50%')).toBeVisible();
    await expect(page.getByText('4 tasks')).toBeVisible();
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

  // -------------------------------------------------------------------------
  // Board batch 5 — configurable column settings (issue #170).
  // -------------------------------------------------------------------------

  test('Columns button opens the settings panel (issue #170)', async ({ page }) => {
    await page.getByRole('button', { name: 'Open board column settings' }).click();
    const panel = page.getByRole('dialog', { name: 'Column settings' });
    await expect(panel).toBeVisible({ timeout: 5_000 });
    // Status codes appear as text labels above each row's input field
    await expect(panel.getByText('BACKLOG')).toBeVisible();
    await expect(panel.getByText('NOT_STARTED')).toBeVisible();
    await expect(panel.getByText('IN_PROGRESS')).toBeVisible();
    await expect(panel.getByText('REVIEW')).toBeVisible();
    await expect(panel.getByText('COMPLETE')).toBeVisible();
  });

  test('settings panel Escape closes it (issue #170)', async ({ page }) => {
    await page.getByRole('button', { name: 'Open board column settings' }).click();
    const panel = page.getByRole('dialog', { name: 'Column settings' });
    await expect(panel).toBeVisible({ timeout: 5_000 });
    await page.keyboard.press('Escape');
    await expect(panel).not.toBeVisible({ timeout: 3_000 });
  });

  // -------------------------------------------------------------------------
  // Board batch 6 — saved views and quick filters (issue #191).
  // -------------------------------------------------------------------------

  test('View dropdown renders with "View" label when no view is active (issue #191)', async ({ page }) => {
    const btn = page.getByRole('button', { name: /board view: view/i });
    await expect(btn).toBeVisible();
  });

  test('View dropdown opens menu with built-in quick filters (issue #191)', async ({ page }) => {
    await page.getByRole('button', { name: /board view: view/i }).click();
    await expect(page.getByRole('menu')).toBeVisible();
    await expect(page.getByText('⚠ At risk')).toBeVisible();
    await expect(page.getByText('🔴 Critical path')).toBeVisible();
    await expect(page.getByText('📅 This week')).toBeVisible();
    await expect(page.getByText('👤 My work')).toBeVisible();
  });

  test('selecting "At risk" updates button label and closes menu (issue #191)', async ({ page }) => {
    await page.getByRole('button', { name: /board view: view/i }).click();
    await page.getByText('⚠ At risk').click();
    await expect(page.getByRole('menu')).not.toBeVisible();
    await expect(page.getByRole('button', { name: /board view: ⚠ at risk/i })).toBeVisible();
  });

  test('"Clear view" appears after activating a built-in view (issue #191)', async ({ page }) => {
    await page.getByRole('button', { name: /board view: view/i }).click();
    await page.getByText('⚠ At risk').click();
    await page.getByRole('button', { name: /board view: ⚠ at risk/i }).click();
    await expect(page.getByText('Clear view')).toBeVisible();
  });

  test('"Clear view" resets button label to "View" (issue #191)', async ({ page }) => {
    await page.getByRole('button', { name: /board view: view/i }).click();
    await page.getByText('🔴 Critical path').click();
    await page.getByRole('button', { name: /board view: 🔴 critical path/i }).click();
    await page.getByText('Clear view').click();
    await expect(page.getByRole('button', { name: /board view: view/i })).toBeVisible();
  });

  test('Sort select is functional and defaults to Priority rank (issue #191)', async ({ page }) => {
    const sortSelect = page.getByLabel('Sort tasks by');
    await expect(sortSelect).toBeVisible();
    await expect(sortSelect).toHaveValue('priority');
    await sortSelect.selectOption('start_date');
    await expect(sortSelect).toHaveValue('start_date');
  });

  test('settings panel edits label and saves (issue #170)', async ({ page }) => {
    let savedColumns: unknown[] | null = null;
    await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/board-config/`, async (route) => {
      if (route.request().method() === 'PUT') {
        const body = route.request().postDataJSON() as { columns: unknown[] };
        savedColumns = body.columns;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ columns: body.columns }),
        });
        return;
      }
      await route.continue();
    });

    await page.getByRole('button', { name: 'Open board column settings' }).click();
    const panel = page.getByRole('dialog', { name: 'Column settings' });
    await expect(panel).toBeVisible({ timeout: 5_000 });

    // Edit the Backlog label
    const backlogInput = panel.getByRole('textbox').first();
    await backlogInput.fill('Ideas');

    await panel.getByRole('button', { name: 'Save' }).click();
    await expect(panel).not.toBeVisible({ timeout: 5_000 });

    // Verify PUT body had the updated label
    const cols = savedColumns as Array<{ status: string; label: string }>;
    expect(cols?.find((c) => c.status === 'BACKLOG')?.label).toBe('Ideas');
  });

  // -------------------------------------------------------------------------
  // Issue #190 — Swimlane collapse/expand toolbar buttons
  // -------------------------------------------------------------------------

  test('"Collapse all" hides leaf task cards (issue #190)', async ({ page }) => {
    await expect(page.getByText('Design')).toBeVisible();
    await page.getByRole('button', { name: 'Collapse all lanes' }).click();
    await expect(page.getByText('Design')).not.toBeVisible({ timeout: 3_000 });
  });

  test('"Expand all" restores cards after collapse-all (issue #190)', async ({ page }) => {
    await page.getByRole('button', { name: 'Collapse all lanes' }).click();
    await expect(page.getByText('Design')).not.toBeVisible({ timeout: 3_000 });
    await page.getByRole('button', { name: 'Expand all lanes' }).click();
    await expect(page.getByText('Design')).toBeVisible({ timeout: 3_000 });
  });

  // -------------------------------------------------------------------------
  // Issue #193 — Card density toggle
  // -------------------------------------------------------------------------

  test('card density select is visible and defaults to comfortable (issue #193)', async ({ page }) => {
    const select = page.getByLabel('Card density');
    await expect(select).toBeVisible();
    await expect(select).toHaveValue('comfortable');
  });

  test('switching to compact keeps board columns visible (issue #193)', async ({ page }) => {
    await page.getByLabel('Card density').selectOption('compact');
    await expect(page.getByText('In Progress')).toBeVisible();
    await expect(page.getByText('Done')).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // Issue #183 — Float chip (b5 QA Gate has total_float: -3)
  // -------------------------------------------------------------------------

  test('negative-float chip renders on QA Gate card (issue #183)', async ({ page }) => {
    await expect(page.getByText('-3d float')).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // Issue #186 — Baseline variance strip (b5: baseline_finish Jan 10,
  // useScheduleTasks reads finish from early_finish = Jan 20 → +10d)
  // -------------------------------------------------------------------------

  test('baseline variance chip renders on QA Gate card (issue #186)', async ({ page }) => {
    // The variance panel is `hidden group-hover:block group-focus-within:block` — only
    // revealed on hover/focus. Assert the chip is attached in the DOM.
    // finish = early_finish = 2026-01-20; baseline_finish = 2026-01-10 → +10d.
    // Pre-#314 fix this asserted +7d because the leaf-task path re-derived
    // finish as start + duration*calendar-day-ms (Jan 5 + 12d = Jan 17). That
    // re-derivation has been removed; early_finish is the authoritative
    // working-day-correct value.
    await expect(page.getByLabel(/Baseline variance: \+10d/)).toBeAttached();
  });

  // -------------------------------------------------------------------------
  // Issue #192 — Card aging (b4 and b5 have status_changed_at in 2025 — >SLA)
  // -------------------------------------------------------------------------

  test('aging chip renders on cards with old status_changed_at (issue #192)', async ({ page }) => {
    // status_changed_at = 2025-11-01, today = 2026-04-30, dwell ≈ 180d → exceeds any column SLA
    const agingChips = page.getByLabel(/days in this column, exceeds/);
    await expect(agingChips.first()).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // Issue #187 — Milestone rail (b4 Release has is_milestone: true)
  // -------------------------------------------------------------------------

  test('milestone rail renders a diamond for Release milestone (issue #187)', async ({ page }) => {
    // PhaseMilestoneRail aria-label format: "{Tone} milestone {name}, target {date}"
    await expect(page.getByLabel(/milestone Release/i)).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // Issue #105 — Entry stamps and priority rank
  // -------------------------------------------------------------------------

  test('priority rank chip renders on card with priority_rank set (issue #105)', async ({ page }) => {
    // b5 QA Gate has priority_rank: 1 → renders "#1" chip
    await expect(page.getByText('#1')).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // Issue #185 — SPI chip renders when EVM mode is spi and baseline data present
  // -------------------------------------------------------------------------

  test('SPI chip renders on card when EVM mode is "spi" (issue #185)', async ({ page }) => {
    await page.getByLabel('EVM indicators').selectOption('spi');
    // b5 QA Gate has baseline_start 2026-01-01, baseline_finish 2026-01-10,
    // early_start 2026-01-05, early_finish 2026-01-20 → SPI computed client-side
    await expect(page.getByLabel(/SPI \d+\.\d+ —/)).toBeVisible({ timeout: 3_000 });
  });
});
