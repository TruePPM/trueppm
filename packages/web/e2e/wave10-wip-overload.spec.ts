/**
 * Wave 10 — WIP-limit overload detection E2E (issue #232).
 *
 * Verifies the at-limit and over-limit chips render on the board column
 * headers, and that moving a task into a column over its WIP limit triggers
 * the confirm prompt.
 */
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-wip-00000000-0000-0000-0000-000000000070';
const BASE_URL = `/projects/${PROJECT_ID}/board`;

const FIXTURE_PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'WIP Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
    methodology: 'HYBRID',
    agile_features: false,
    estimation_mode: 'open',
    server_version: 1,
  },
];

const FIXTURE_TASKS = [
  // Summary phase
  {
    id: 'phase-1',
    wbs_path: '1',
    name: 'Phase 1',
    early_start: '2026-04-01',
    early_finish: '2026-04-30',
    duration: 30,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    is_summary: true,
    parent_id: null,
    status: 'IN_PROGRESS',
    assignees: [],
    total_float: null,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
    server_version: 1,
  },
  // Two leaves in IN_PROGRESS — wip_limit will be set to 1, so the column
  // is over-limit on initial load (count=2, limit=1).
  {
    id: 'task-a',
    wbs_path: '1.1',
    name: 'Wire telemetry',
    early_start: '2026-04-01',
    early_finish: '2026-04-05',
    duration: 5,
    percent_complete: 50,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: 'phase-1',
    status: 'IN_PROGRESS',
    assignees: [],
    total_float: null,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
    server_version: 1,
  },
  {
    id: 'task-b',
    wbs_path: '1.2',
    name: 'Calibrate sensors',
    early_start: '2026-04-06',
    early_finish: '2026-04-10',
    duration: 5,
    percent_complete: 25,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: 'phase-1',
    status: 'IN_PROGRESS',
    assignees: [],
    total_float: null,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
    server_version: 1,
  },
  // One TO DO task to move-to IN_PROGRESS (which is at WIP limit). This
  // used to be a BACKLOG fixture; after #381 BACKLOG cards live in the
  // BacklogBand rail and have no overflow menu, so the move-to confirm
  // dialog can't be triggered from there. NOT_STARTED preserves the test
  // intent (WIP-limit confirm prompt + cancel) without depending on the
  // old BACKLOG column.
  {
    id: 'task-c',
    wbs_path: '1.3',
    name: 'Draft FAT plan',
    early_start: '2026-04-11',
    early_finish: '2026-04-15',
    duration: 5,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: 'phase-1',
    status: 'NOT_STARTED',
    assignees: [],
    total_float: null,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
    server_version: 1,
  },
];

const BOARD_CONFIG = {
  columns: [
    { status: 'BACKLOG', label: 'Backlog', visible: true, wip_limit: null, color: '#94A3B8' },
    { status: 'NOT_STARTED', label: 'To Do', visible: true, wip_limit: null, color: '#64748B' },
    { status: 'IN_PROGRESS', label: 'In Progress', visible: true, wip_limit: 1, color: '#3B82F6' },
    { status: 'REVIEW', label: 'Review', visible: true, wip_limit: null, color: '#A855F7' },
    { status: 'COMPLETE', label: 'Done', visible: true, wip_limit: null, color: '#22C55E' },
  ],
};

async function setupCommon(page: import('@playwright/test').Page) {
  // Shared harness (e2e/fixtures): setupCatchAll returns 404 for any stray
  // endpoint instead of letting it proxy to the real backend and 401 on the
  // dummy e2e token — a 401 cascades through auth/token/refresh into the
  // session-expired modal, which then intercepts board clicks. setupApiMocks
  // supplies correct shapes for every board endpoint (tasks, members?self,
  // board-config, monte-carlo/latest, ws/ticket, notifications, sprints, …).
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: FIXTURE_PROJECTS,
    projectId: PROJECT_ID,
    tasks: FIXTURE_TASKS,
    boardConfig: BOARD_CONFIG,
    statusSummary: { task_count: FIXTURE_TASKS.length },
    overview: { total_tasks: FIXTURE_TASKS.length, start_date: '2026-04-01' },
  });
}

test.describe('Wave 10 — WIP-limit overload detection', () => {
  test('renders the over-limit chip on a column whose count exceeds its WIP limit', async ({
    page,
  }) => {
    await setupCommon(page);
    await page.goto(BASE_URL);
    // Wait for the board to leave its loading state — TanStack Query needs
    // a tick after the route mocks resolve before the columns paint. The
    // loading skeleton is a role="status" node named "Loading board…" with no
    // visible text, so gate on that node detaching (getByText would read
    // count-0 before the board even mounts and resolve vacuously).
    await expect(page.getByRole('status', { name: /Loading board/i })).toHaveCount(0, {
      timeout: 15_000,
    });
    // IN_PROGRESS has 2 leaves and wip_limit=1 → over-limit chip.
    await expect(page.getByLabel(/2 of 1 WIP limit, over limit/i)).toBeVisible();
    await expect(page.getByText(/2\/1 — over WIP limit/i)).toBeVisible();
  });

  test('move-to a WIP-breached column shows a styled confirm; declining cancels the move (#2050)', async ({
    page,
  }) => {
    await setupCommon(page);
    // A native window.confirm would surface as a page 'dialog' event; the #2050
    // fix replaces it with a styled role="alertdialog", so a fired native dialog
    // is now a regression. Fail loudly if one appears.
    page.on('dialog', (dlg) => {
      throw new Error(`Unexpected native dialog: ${dlg.message()}`);
    });

    let patchCalled = false;
    await page.route('**/api/v1/tasks/task-c/', (route) => {
      if (route.request().method() === 'PATCH') {
        patchCalled = true;
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ id: 'task-c', status: 'IN_PROGRESS' }),
        });
      }
      return route.continue();
    });

    await page.goto(BASE_URL);

    // Open the TO DO card's overflow menu and try to move it to IN PROGRESS.
    const trigger = page.getByLabel(/Actions for Draft FAT plan/i);
    await trigger.click();
    await page.getByRole('menuitem', { name: /^Move to/i }).click();
    await page.getByRole('menuitem', { name: /In Progress/i }).click();

    // The styled alertdialog names the column and its breached limit.
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(/at or over its WIP limit \(2\/1\)/i);
    // Cancel-first: "Keep it here" is the safe default and cancels the move.
    await dialog.getByRole('button', { name: /Keep it here/i }).click();
    await expect(dialog).toHaveCount(0);
    expect(patchCalled).toBe(false);
  });

  test('breach confirm still fires with the "Show WIP limits" display toggle OFF (#2169)', async ({
    page,
  }) => {
    await setupCommon(page);
    // The cosmetic display toggle must not disable the process guardrail — a
    // breach is a signal, not an opt-in detail (rules 176/261). Turning it off
    // used to silently drop the over-limit confirm entirely (#2169).
    page.on('dialog', (dlg) => {
      throw new Error(`Unexpected native dialog: ${dlg.message()}`);
    });

    let patchCalled = false;
    await page.route('**/api/v1/tasks/task-c/', (route) => {
      if (route.request().method() === 'PATCH') {
        patchCalled = true;
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ id: 'task-c', status: 'IN_PROGRESS' }),
        });
      }
      return route.continue();
    });

    await page.goto(BASE_URL);
    await expect(page.getByRole('status', { name: /Loading board/i })).toHaveCount(0, {
      timeout: 15_000,
    });

    // Turn OFF "Show WIP limits" in the More menu.
    await page.getByRole('button', { name: 'More board controls' }).click();
    await page.getByLabel('Show WIP limits').uncheck();
    await page.keyboard.press('Escape');

    // Move-to the breached column — the styled confirm must still appear.
    const trigger = page.getByLabel(/Actions for Draft FAT plan/i);
    await trigger.click();
    await page.getByRole('menuitem', { name: /^Move to/i }).click();
    await page.getByRole('menuitem', { name: /In Progress/i }).click();

    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(/at or over its WIP limit \(2\/1\)/i);
    await dialog.getByRole('button', { name: /Keep it here/i }).click();
    await expect(dialog).toHaveCount(0);
    expect(patchCalled).toBe(false);
  });

  test('confirming the WIP-breach dialog completes the move (#2050)', async ({ page }) => {
    await setupCommon(page);
    page.on('dialog', (dlg) => {
      throw new Error(`Unexpected native dialog: ${dlg.message()}`);
    });

    let patchStatus: string | null = null;
    await page.route('**/api/v1/tasks/task-c/', (route) => {
      if (route.request().method() === 'PATCH') {
        const body = route.request().postDataJSON() as { status?: string };
        patchStatus = body.status ?? null;
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ id: 'task-c', status: 'IN_PROGRESS' }),
        });
      }
      return route.continue();
    });

    await page.goto(BASE_URL);

    const trigger = page.getByLabel(/Actions for Draft FAT plan/i);
    await trigger.click();
    await page.getByRole('menuitem', { name: /^Move to/i }).click();
    await page.getByRole('menuitem', { name: /In Progress/i }).click();

    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: /Move anyway/i }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => patchStatus).toBe('IN_PROGRESS');
  });
});
